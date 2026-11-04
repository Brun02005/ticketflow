import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  createPool,
  createTokenVerifier,
  type DomainEvent,
  PoisonMessageError,
  type Pool,
  type Role,
  runMigrations,
} from '@ticketflow/common'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { backoffSeconds, type DispatchOptions, dispatchDue } from '../src/dispatcher'
import { handleMessage } from '../src/handlers'
import { createSmtpMailer, type Mailer, type OutgoingEmail } from '../src/mailer'
import { signTicket, verifyTicket } from '../src/tickets'

const TICKET_SECRET = 'test-ticket-secret-123'
const MAILPIT = process.env.TEST_MAILPIT_API!
const silent = { info() {}, warn() {}, error() {} }
const options: DispatchOptions = {
  maxAttempts: 3,
  retryBaseSeconds: 10,
  timezone: 'America/Argentina/Buenos_Aires',
  ticketSecret: TICKET_SECRET,
}

let pool: Pool
let smtp: Mailer

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!)
  await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), { info() {} })
  smtp = createSmtpMailer({
    host: process.env.TEST_SMTP_HOST!,
    port: 1025,
    secure: false,
    from: 'TicketFlow <test@ticketflow.test>',
  })
})

beforeEach(async () => {
  await pool.query('TRUNCATE users, events, notifications, processed_messages')
})

afterAll(async () => {
  smtp.close()
  await pool.end()
})

const msg = (type: string, payload: unknown, messageId: string = randomUUID()): DomainEvent => ({
  messageId,
  type,
  aggregateId: 'x',
  occurredAt: new Date().toISOString(),
  payload,
})
const handle = (type: string, payload: unknown, messageId?: string) =>
  handleMessage(pool, msg(type, payload, messageId), silent)

const notifications = async () =>
  (
    await pool.query(
      `SELECT id, kind, status, attempts, last_error, next_attempt_at FROM notifications ORDER BY created_at`,
    )
  ).rows

async function seed() {
  const userId = randomUUID()
  const email = `comprador-${randomUUID().slice(0, 8)}@ticketflow.test`
  const eventId = randomUUID()
  await handle('user.registered', { userId, email, role: 'customer' })
  await handle('event.published', {
    id: eventId,
    title: 'Festival <Rock> & Blues',
    venueName: 'Estadio Central',
    city: 'Rosario',
    startsAt: '2027-03-20T23:30:00.000Z',
  })
  await pool.query(`DELETE FROM notifications`) // descartamos el email de bienvenida
  return { userId, email, eventId }
}

const paidOrder = (userId: string, eventId: string, orderId = randomUUID()) => ({
  id: orderId,
  userId,
  eventId,
  totalCents: 30_000,
  currency: 'ARS',
  status: 'paid',
  items: [
    { sectionId: randomUUID(), sectionName: 'Campo', row: 1, number: 7, priceCents: 15_000 },
    { sectionId: randomUUID(), sectionName: 'Campo', row: 1, number: 8, priceCents: 15_000 },
  ],
})

interface MailpitMessage {
  Subject: string
  MessageID: string
  HTML: string
  Text: string
  Inline: { ContentType: string }[]
}

async function mailpitMessage(to: string): Promise<MailpitMessage | null> {
  const search = (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((r) =>
    r.json(),
  )) as { messages?: { ID: string }[] }
  if (!search.messages?.length) return null
  return (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`).then((r) => r.json())) as MailpitMessage
}

describe('de mensajes a notificaciones', () => {
  it('cada hecho de negocio genera un solo email, aunque llegue repetido por distintos mensajes', async () => {
    const { userId, eventId } = await seed()
    const order = paidOrder(userId, eventId)

    const messageId = randomUUID()
    await handle('order.paid', order, messageId)
    await handle('order.paid', order, messageId) // reentrega del mismo mensaje
    await handle('order.paid', order) // mismo hecho, otro mensaje (el relay publicó dos veces)

    expect((await notifications()).map((n) => n.kind)).toEqual(['tickets'])
  })

  it('solo avisa las cancelaciones hechas por el organizador, no las del propio usuario', async () => {
    const { userId, eventId } = await seed()
    await handle('order.cancelled', { orderId: randomUUID(), userId, eventId, reason: 'user' })
    await handle('order.cancelled', {
      orderId: randomUUID(),
      userId,
      eventId,
      reason: 'event_cancelled',
      wasPaid: true,
    })

    expect((await notifications()).map((n) => n.kind)).toEqual(['event_cancelled'])
  })

  it('un mensaje que no cumple el contrato va a la DLQ', async () => {
    await expect(handle('order.paid', { id: 'x' })).rejects.toBeInstanceOf(PoisonMessageError)
  })
})

describe('envío real por SMTP (Mailpit)', () => {
  it('manda las entradas con un QR por asiento, firmado y verificable', async () => {
    const { userId, email, eventId } = await seed()
    const order = paidOrder(userId, eventId)
    await handle('order.paid', order)

    expect(await dispatchDue(pool, smtp, options, silent)).toEqual({ sent: 1, retried: 0, failed: 0 })

    await expect.poll(() => mailpitMessage(email)).not.toBeNull()
    const mail = (await mailpitMessage(email))!
    expect(mail.Subject).toBe('Tus entradas para Festival <Rock> & Blues')
    // El HTML escapa lo que viene de los usuarios: nada de inyección en el email.
    expect(mail.HTML).toContain('Festival &lt;Rock&gt; &amp; Blues')
    expect(mail.Inline.map((p) => p.ContentType)).toEqual(['image/png', 'image/png'])

    const [{ id }] = await notifications()
    expect(mail.MessageID).toBe(`${id}@ticketflow.test`)

    const codes = mail.Text.match(/TF1\.[\w-]+\.[\w-]+/g)!
    expect(codes).toHaveLength(2)
    expect(verifyTicket(TICKET_SECRET, codes[0]!)).toMatchObject({ orderId: order.id, row: 1, number: 7 })
  })
})

describe('reintentos', () => {
  const failingMailer = (): Mailer & { calls: number } => ({
    calls: 0,
    async send() {
      this.calls++
      throw new Error('SMTP caído')
    },
    close() {},
  })
  const makeDue = () => pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE status = 'pending'`)

  it('si faltan datos (el evento todavía no llegó), reintenta más tarde', async () => {
    const { userId } = await seed()
    await handle('order.paid', paidOrder(userId, randomUUID()))

    expect(await dispatchDue(pool, smtp, options, silent)).toEqual({ sent: 0, retried: 1, failed: 0 })
    const [n] = await notifications()
    expect(n).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'todavía no se conocen los datos del evento',
    })
    expect(n.next_attempt_at.getTime()).toBeGreaterThan(Date.now())
  })

  it('backoff exponencial y, al agotar los intentos, queda como fallida', async () => {
    const { userId, eventId } = await seed()
    await handle('order.paid', paidOrder(userId, eventId))
    const mailer = failingMailer()

    for (let i = 0; i < 3; i++) {
      await makeDue()
      await dispatchDue(pool, mailer, options, silent)
    }

    expect(mailer.calls).toBe(3)
    expect((await notifications())[0]).toMatchObject({ status: 'failed', attempts: 3, last_error: 'SMTP caído' })
    // Una fallida no se vuelve a intentar sola.
    await makeDue()
    expect(await dispatchDue(pool, mailer, options, silent)).toEqual({ sent: 0, retried: 0, failed: 0 })
  })

  it('el backoff crece exponencialmente y tiene tope', () => {
    const avg = (attempt: number) => backoffSeconds(attempt, 10)
    expect(avg(1)).toBeGreaterThanOrEqual(8)
    expect(avg(1)).toBeLessThanOrEqual(12)
    expect(avg(4)).toBeGreaterThanOrEqual(64)
    expect(avg(4)).toBeLessThanOrEqual(96)
    expect(avg(30)).toBeLessThanOrEqual(3600 * 1.2)
  })

  it('una notificación tomada no se reenvía hasta que vence su lease', async () => {
    const { userId, eventId } = await seed()
    await handle('order.paid', paidOrder(userId, eventId))
    // Simulamos un proceso que la reclamó y murió antes de enviarla.
    await pool.query(`UPDATE notifications SET attempts = 1, next_attempt_at = now() + interval '2 minutes'`)

    expect((await dispatchDue(pool, smtp, options, silent)).sent).toBe(0)
    await makeDue() // venció el lease
    expect((await dispatchDue(pool, smtp, options, silent)).sent).toBe(1)
  })

  it('varias réplicas del despachador: cada email se envía exactamente una vez', async () => {
    const { userId, eventId } = await seed()
    for (let i = 0; i < 20; i++) await handle('order.paid', paidOrder(userId, eventId))
    const sent: string[] = []
    const slow: Mailer = {
      async send(email: OutgoingEmail) {
        await new Promise((r) => setTimeout(r, 10))
        sent.push(email.messageId)
      },
      close() {},
    }

    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while ((await dispatchDue(pool, slow, { ...options, batchSize: 3 }, silent)).sent > 0) {}
      }),
    )

    expect(sent).toHaveLength(20)
    expect(new Set(sent).size).toBe(20)
  })
})

describe('API de operación', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const tokenFor = (role: Role) =>
    new SignJWT({ role })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(randomUUID())
      .setIssuer('ticketflow-auth')
      .setAudience('ticketflow')
      .setExpirationTime('5m')
      .sign(privateKey)

  const makeApp = () =>
    buildApp(
      loadConfig({
        LOG_LEVEL: 'silent',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        RABBITMQ_URL: 'amqp://unused',
        AUTH_JWKS_URL: 'http://unused',
        SMTP_HOST: 'unused',
        TICKET_SIGNING_SECRET: TICKET_SECRET,
      }),
      { pool, verifyToken: createTokenVerifier({ key: publicKey, issuer: 'ticketflow-auth', audience: 'ticketflow' }) },
    )

  it('un admin puede ver las notificaciones fallidas y reencolarlas', async () => {
    const app = await makeApp()
    const { userId, eventId } = await seed()
    await handle('order.paid', paidOrder(userId, eventId))
    await pool.query(`UPDATE notifications SET status = 'failed', attempts = 8, last_error = 'SMTP caído'`)
    const admin = { authorization: `Bearer ${await tokenFor('admin')}` }

    const list = await app.inject({ method: 'GET', url: '/notifications?status=failed', headers: admin })
    expect(list.json().items).toHaveLength(1)

    const retry = await app.inject({
      method: 'POST',
      url: `/notifications/${list.json().items[0].id}/retry`,
      headers: admin,
    })
    expect(retry.json()).toEqual({ requeued: true })
    expect((await notifications())[0]).toMatchObject({ status: 'pending', attempts: 0 })

    const asCustomer = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { authorization: `Bearer ${await tokenFor('customer')}` },
    })
    expect(asCustomer.statusCode).toBe(403)
    await app.close()
  })

  it('el personal del evento valida QRs; uno adulterado no pasa', async () => {
    const app = await makeApp()
    const code = signTicket(TICKET_SECRET, {
      orderId: randomUUID(),
      eventId: randomUUID(),
      sectionId: randomUUID(),
      row: 3,
      number: 9,
    })
    const [data, signature] = code.split('.').slice(1)
    const forged = `TF1.${Buffer.from(JSON.stringify(['o', 'e', 's', 1, 1])).toString('base64url')}.${signature}`
    const verify = async (c: string, role: Role = 'organizer') =>
      app.inject({
        method: 'POST',
        url: '/tickets/verify',
        headers: { authorization: `Bearer ${await tokenFor(role)}` },
        payload: { code: c },
      })

    expect((await verify(code)).json()).toMatchObject({ valid: true, ticket: { row: 3, number: 9 } })
    expect((await verify(forged)).json()).toEqual({ valid: false })
    expect((await verify(`TF1.${data}.firma-inventada`)).json()).toEqual({ valid: false })
    expect((await verify(code, 'customer')).statusCode).toBe(403)
    await app.close()
  })
})
