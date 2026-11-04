import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  createPool,
  createTokenVerifier,
  type DomainEvent,
  type Pool,
  type Role,
  runMigrations,
} from '@ticketflow/common'
import { SignJWT } from 'jose'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { handleDomainEvent } from '../src/projection'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
export const verifyToken = createTokenVerifier({ key: publicKey, issuer: 'ticketflow-auth', audience: 'ticketflow' })

export interface TestUser {
  id: string
  token: string
}

export async function makeUser(role: Role = 'customer'): Promise<TestUser> {
  const id = randomUUID()
  const token = await new SignJWT({ role })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(id)
    .setIssuer('ticketflow-auth')
    .setAudience('ticketflow')
    .setExpirationTime('10m')
    .sign(privateKey)
  return { id, token }
}

export const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    RABBITMQ_URL: process.env.TEST_RABBITMQ_URL,
    AUTH_JWKS_URL: 'http://unused.test/jwks.json',
    ...overrides,
  })

export async function setupDb(): Promise<Pool> {
  // Pool más grande que el default: los tests de concurrencia disparan muchas transacciones a la vez.
  const pool = createPool(process.env.TEST_DATABASE_URL!, { max: 30 })
  await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), { info() {} })
  return pool
}

export async function resetData(pool: Pool) {
  await pool.query(
    'TRUNCATE events, sections, seats, orders, order_items, idempotency_keys, processed_messages, outbox CASCADE',
  )
}

export function makeApp(pool: Pool, overrides: Record<string, string> = {}) {
  return buildApp(testConfig(overrides), { pool, verifyToken })
}

export const silentLogger = { info() {}, warn() {}, error() {} }

export function domainEvent(type: string, payload: unknown, messageId: string = randomUUID()): DomainEvent {
  return { messageId, type, aggregateId: 'test', occurredAt: new Date().toISOString(), payload }
}

export interface SeededEvent {
  id: string
  sections: { id: string; name: string; priceCents: number; rows: number; seatsPerRow: number }[]
}

/** Publica un evento "como lo haría events-service": pasa por el mismo handler que el consumidor. */
export async function seedEvent(
  pool: Pool,
  sections: { name?: string; priceCents?: number; rows: number; seatsPerRow: number }[] = [
    { rows: 5, seatsPerRow: 10 },
  ],
  startsAt = new Date(Date.now() + 30 * 86_400_000).toISOString(),
): Promise<SeededEvent> {
  const event = {
    id: randomUUID(),
    title: 'Evento de prueba',
    startsAt,
    currency: 'ARS',
    status: 'published',
    sections: sections.map((s, i) => ({
      id: randomUUID(),
      name: s.name ?? `Sector ${i + 1}`,
      priceCents: s.priceCents ?? 10_000,
      rows: s.rows,
      seatsPerRow: s.seatsPerRow,
    })),
  }
  await handleDomainEvent(pool, domainEvent('event.published', event), silentLogger)
  return event
}
