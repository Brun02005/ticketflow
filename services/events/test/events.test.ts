import { createRedis, type Pool, type Redis } from '@ticketflow/common'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import {
  daysFromNow,
  eventInput,
  makeApp,
  makeUser,
  resetData,
  setupInfra,
  type TestUser,
  testConfig,
  verifyToken,
} from './helpers'

type App = Awaited<ReturnType<typeof buildApp>>

let pool: Pool
let redis: Redis
let app: App
let organizer: TestUser
let otherOrganizer: TestUser
let customer: TestUser
let admin: TestUser

beforeAll(async () => {
  ;({ pool, redis } = await setupInfra())
  ;[organizer, otherOrganizer, customer, admin] = await Promise.all([
    makeUser('organizer'),
    makeUser('organizer'),
    makeUser('customer'),
    makeUser('admin'),
  ])
})

beforeEach(async () => {
  await resetData(pool, redis)
  app = await makeApp(pool, redis)
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  redis.disconnect()
  await pool.end()
})

const auth = (user?: TestUser) => (user ? { authorization: `Bearer ${user.token}` } : {})

const createEvent = (user: TestUser | undefined, body: Record<string, unknown> = eventInput()) =>
  app.inject({ method: 'POST', url: '/events', headers: auth(user), payload: body })

const getEvent = (id: string, user?: TestUser) =>
  app.inject({ method: 'GET', url: `/events/${id}`, headers: auth(user) })

const action = (id: string, name: 'publish' | 'cancel', user: TestUser) =>
  app.inject({ method: 'POST', url: `/events/${id}/${name}`, headers: auth(user) })

const patch = (id: string, user: TestUser, body: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/events/${id}`, headers: auth(user), payload: body })

async function publishedEvent(overrides: Record<string, unknown> = {}) {
  const event = (await createEvent(organizer, eventInput(overrides))).json()
  return (await action(event.id, 'publish', organizer)).json()
}

const outboxRows = async () => (await pool.query('SELECT type, aggregate_id, payload FROM outbox ORDER BY id')).rows

describe('crear eventos', () => {
  it('un organizador crea un borrador con capacidad calculada', async () => {
    const res = await createEvent(organizer)

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      organizerId: organizer.id,
      status: 'draft',
      version: 1,
      currency: 'ARS',
      capacity: 10 * 20 + 5 * 10,
    })
    expect(res.json().sections.map((s: { name: string }) => s.name)).toEqual(['Campo', 'Platea'])
  })

  it('exige autenticación y rol de organizador', async () => {
    expect((await createEvent(undefined)).statusCode).toBe(401)

    const asCustomer = await createEvent(customer)
    expect(asCustomer.statusCode).toBe(403)
    expect(asCustomer.json().error.code).toBe('INSUFFICIENT_ROLE')
  })

  it('chequea permisos antes de validar el body (sin rol: 403, no 400)', async () => {
    // Un usuario sin permisos no debería poder sondear qué formato espera el endpoint.
    expect((await createEvent(undefined, {})).statusCode).toBe(401)
    expect((await createEvent(customer, {})).statusCode).toBe(403)
  })

  it('rechaza fechas pasadas y bodies inválidos', async () => {
    const past = await createEvent(organizer, eventInput({ startsAt: daysFromNow(-1) }))
    expect(past.json().error.code).toBe('START_IN_PAST')

    const noSections = await createEvent(organizer, eventInput({ sections: [] }))
    expect(noSections.statusCode).toBe(400)
  })
})

describe('visibilidad de borradores', () => {
  it('solo el organizador ve su borrador; para el resto no existe', async () => {
    const { id } = (await createEvent(organizer)).json()

    expect((await getEvent(id, organizer)).statusCode).toBe(200)
    expect((await getEvent(id, admin)).statusCode).toBe(200)
    expect((await getEvent(id, otherOrganizer)).statusCode).toBe(404)
    expect((await getEvent(id)).statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/events' })
    expect(list.json().items).toHaveLength(0)
  })
})

describe('publicar', () => {
  it('publica y deja el evento de dominio en el outbox en la misma transacción', async () => {
    const { id } = (await createEvent(organizer)).json()
    const res = await action(id, 'publish', organizer)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'published', version: 2 })
    expect(res.json().publishedAt).not.toBeNull()

    const [message] = await outboxRows()
    expect(message).toMatchObject({ type: 'event.published', aggregate_id: id })
    expect(message.payload.sections).toHaveLength(2)
  })

  it('no se puede publicar dos veces', async () => {
    const { id } = await publishedEvent()
    const res = await action(id, 'publish', organizer)

    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('INVALID_STATUS_TRANSITION')
  })

  it('dos publicaciones simultáneas: una sola gana y se emite un solo evento', async () => {
    const { id } = (await createEvent(organizer)).json()
    const results = await Promise.all([action(id, 'publish', organizer), action(id, 'publish', organizer)])

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(await outboxRows()).toHaveLength(1)
  })

  it('otro organizador no puede publicar un evento ajeno; un admin sí', async () => {
    const { id } = (await createEvent(organizer)).json()

    expect((await action(id, 'publish', otherOrganizer)).statusCode).toBe(404)
    expect((await action(id, 'publish', admin)).statusCode).toBe(200)
  })
})

describe('editar con bloqueo optimista', () => {
  it('incrementa la versión y reemplaza los sectores', async () => {
    const { id } = (await createEvent(organizer)).json()
    const res = await patch(id, organizer, {
      version: 1,
      title: 'Nuevo título',
      sections: [{ name: 'General', priceCents: 1000, rows: 1, seatsPerRow: 100 }],
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ title: 'Nuevo título', version: 2, capacity: 100 })
    expect(res.json().sections).toHaveLength(1)
  })

  it('rechaza una versión desactualizada', async () => {
    const { id } = (await createEvent(organizer)).json()
    await patch(id, organizer, { version: 1, title: 'Primer cambio' })

    const stale = await patch(id, organizer, { version: 1, title: 'Cambio sobre datos viejos' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('VERSION_CONFLICT')
  })

  it('dos ediciones simultáneas sobre la misma versión: una gana, la otra recibe 409', async () => {
    const { id } = (await createEvent(organizer)).json()
    const results = await Promise.all([
      patch(id, organizer, { version: 1, title: 'Edición A' }),
      patch(id, organizer, { version: 1, title: 'Edición B' }),
    ])

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect((await getEvent(id, organizer)).json().version).toBe(2)
  })

  it('no permite editar eventos ya publicados', async () => {
    const { id, version } = await publishedEvent()
    const res = await patch(id, organizer, { version, title: 'Tarde' })
    expect(res.json().error.code).toBe('EVENT_NOT_EDITABLE')
  })
})

describe('cancelar', () => {
  it('cancelar un evento publicado emite event.cancelled', async () => {
    const { id } = await publishedEvent()
    const res = await action(id, 'cancel', organizer)

    expect(res.json().status).toBe('cancelled')
    expect((await outboxRows()).map((r) => r.type)).toEqual(['event.published', 'event.cancelled'])
  })

  it('cancelar un borrador no emite nada (nunca fue público)', async () => {
    const { id } = (await createEvent(organizer)).json()
    await action(id, 'cancel', organizer)
    expect(await outboxRows()).toHaveLength(0)
  })
})

describe('caché', () => {
  it('la segunda lectura sale de Redis y un cambio de estado la invalida', async () => {
    const { id } = await publishedEvent()

    expect((await getEvent(id)).headers['x-cache']).toBe('MISS')
    expect((await getEvent(id)).headers['x-cache']).toBe('HIT')

    await action(id, 'cancel', organizer)
    const afterCancel = await getEvent(id)
    expect(afterCancel.headers['x-cache']).toBe('MISS')
    expect(afterCancel.json().status).toBe('cancelled')
  })

  it('si Redis se cae, el servicio sigue respondiendo desde la base', async () => {
    const { id } = await publishedEvent()
    const deadRedis = createRedis('redis://127.0.0.1:6390')
    deadRedis.on('error', () => {})
    const degraded = await buildApp(testConfig(), { pool, redis: deadRedis, verifyToken })

    const res = await degraded.inject({ method: 'GET', url: `/events/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('MISS')

    const ready = await degraded.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json().checks).toEqual({ postgres: 'ok', redis: 'fail' })

    await degraded.close()
    deadRedis.disconnect()
  })
})

describe('listado público', () => {
  const list = (query: string) => app.inject({ method: 'GET', url: `/events?${query}` })

  it('pagina con cursor sin repetir ni saltear eventos', async () => {
    for (let i = 1; i <= 5; i++) await publishedEvent({ title: `Evento ${i}`, startsAt: daysFromNow(i) })

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await list(`limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...res.json().items.map((e: { title: string }) => e.title))
      cursor = res.json().nextCursor
      pages++
    } while (cursor)

    expect(pages).toBe(3)
    expect(seen).toEqual(['Evento 1', 'Evento 2', 'Evento 3', 'Evento 4', 'Evento 5'])
  })

  it('devuelve precio mínimo y capacidad total', async () => {
    await publishedEvent()
    const [item] = (await list('')).json().items
    expect(item).toMatchObject({ minPriceCents: 50_000_00, capacity: 250 })
  })

  it('filtra por ciudad y por texto parcial en el título', async () => {
    await publishedEvent({ title: 'Festival de Rock', city: 'Córdoba' })
    await publishedEvent({ title: 'Noche de Jazz', city: 'Rosario' })
    await publishedEvent({ title: 'Rock Nacional', city: 'Rosario' })

    const rockInRosario = await list(`q=rock&city=rosario`)
    expect(rockInRosario.json().items.map((e: { title: string }) => e.title)).toEqual(['Rock Nacional'])
  })

  it('trata % y _ de la búsqueda como texto literal', async () => {
    await publishedEvent({ title: 'Descuento 100% garantizado' })
    await publishedEvent({ title: 'Otro evento' })

    expect((await list(`q=${encodeURIComponent('100%')}`)).json().items).toHaveLength(1)
    expect((await list(`q=${encodeURIComponent('%%')}`)).json().items).toHaveLength(0)
  })

  it('rechaza un cursor adulterado', async () => {
    const res = await list('cursor=no-es-un-cursor')
    expect(res.json().error.code).toBe('INVALID_CURSOR')
  })
})

describe('panel del organizador', () => {
  it('lista solo los eventos propios, en todos los estados', async () => {
    await createEvent(organizer)
    await publishedEvent()
    await createEvent(otherOrganizer)

    const res = await app.inject({ method: 'GET', url: '/organizer/events', headers: auth(organizer) })
    expect(res.json().items).toHaveLength(2)
    expect(new Set(res.json().items.map((e: { status: string }) => e.status))).toEqual(new Set(['draft', 'published']))
  })
})
