import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createPool, createTokenVerifier, type DomainEvent, type Pool, runMigrations } from '@ticketflow/common'
import { SignJWT } from 'jose'
import { buildApp as buildPsp, loadConfig as loadPspConfig } from '../../psp/src/app'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { PspClient } from '../src/psp-client'
import { handleOrderMessage } from '../src/saga'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
export const verifyToken = createTokenVerifier({ key: publicKey, issuer: 'ticketflow-auth', audience: 'ticketflow' })

export const PSP_API_KEY = 'sk_test_payments'
export const WEBHOOK_SECRET = 'whsec_test_payments'
export const silentLogger = { info() {}, warn() {}, error() {} }

export const CARDS = {
  ok: '4242424242424242',
  declined: '4000000000000002',
  duplicateWebhook: '4000000000000077',
  lostWebhook: '4000000000000101',
}

export async function makeUser() {
  const id = randomUUID()
  const token = await new SignJWT({ role: 'customer' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(id)
    .setIssuer('ticketflow-auth')
    .setAudience('ticketflow')
    .setExpirationTime('10m')
    .sign(privateKey)
  return { id, token }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/**
 * Levanta la pasarela simulada y payments-service escuchando en puertos reales:
 * los webhooks viajan por HTTP de verdad, firmados, igual que en producción.
 */
export async function startStack() {
  const pool = createPool(process.env.TEST_DATABASE_URL!)
  await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), { info() {} })

  const psp = await buildPsp(
    loadPspConfig({
      LOG_LEVEL: 'silent',
      PSP_API_KEY,
      PSP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PSP_MIN_DELAY_MS: '5',
      PSP_MAX_DELAY_MS: '20',
      PSP_WEBHOOK_RETRY_BASE_MS: '20',
    }),
  )
  await psp.listen({ port: 0, host: '127.0.0.1' })
  const pspUrl = `http://127.0.0.1:${(psp.server.address() as { port: number }).port}`

  const port = await freePort()
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    RABBITMQ_URL: 'amqp://unused',
    AUTH_JWKS_URL: 'http://unused/jwks.json',
    PSP_URL: pspUrl,
    PSP_API_KEY,
    PSP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_WEBHOOK_URL: `http://127.0.0.1:${port}/webhooks/psp`,
  })
  const app = await buildApp(config, { pool, verifyToken })
  await app.listen({ port, host: '127.0.0.1' })

  return {
    pool,
    psp,
    app,
    config,
    pspClient: new PspClient({ baseUrl: pspUrl, apiKey: PSP_API_KEY }),
    async close() {
      await app.close()
      await psp.close()
      await pool.end()
    },
  }
}

export async function resetData(pool: Pool) {
  await pool.query('TRUNCATE payments, charges, webhook_events, processed_messages, outbox CASCADE')
}

export function message(type: string, payload: unknown): DomainEvent {
  return { messageId: randomUUID(), type, aggregateId: 'test', occurredAt: new Date().toISOString(), payload }
}

/** Simula que orders creó una orden (mensaje order.created por RabbitMQ). */
export async function orderCreated(pool: Pool, userId: string, overrides: Record<string, unknown> = {}) {
  const order = {
    id: randomUUID(),
    userId,
    eventId: randomUUID(),
    totalCents: 15_000,
    currency: 'ARS',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    status: 'pending_payment',
    items: [],
    ...overrides,
  }
  await handleOrderMessage(pool, message('order.created', order), silentLogger)
  return order
}
