import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  createPool,
  createRedis,
  createTokenVerifier,
  type Pool,
  type Redis,
  type Role,
  runMigrations,
  waitForRedis,
} from '@ticketflow/common'
import { SignJWT } from 'jose'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'

/**
 * Los tests no levantan auth-service: generan su propio par de claves y firman
 * tokens igual que lo haría auth. Así se prueba la validación real del JWT.
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const ISSUER = 'ticketflow-auth'
const AUDIENCE = 'ticketflow'

export const verifyToken = createTokenVerifier({ key: publicKey, issuer: ISSUER, audience: AUDIENCE })

export interface TestUser {
  id: string
  role: Role
  token: string
}

export async function makeUser(role: Role): Promise<TestUser> {
  const id = randomUUID()
  const token = await new SignJWT({ role })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
  return { id, role, token }
}

export const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL,
    RABBITMQ_URL: process.env.TEST_RABBITMQ_URL,
    AUTH_JWKS_URL: 'http://unused.test/jwks.json',
    ...overrides,
  })

export async function setupInfra(): Promise<{ pool: Pool; redis: Redis }> {
  const pool = createPool(process.env.TEST_DATABASE_URL!)
  await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), { info() {} })
  const redis = createRedis(process.env.TEST_REDIS_URL!)
  await waitForRedis(redis)
  return { pool, redis }
}

export async function resetData(pool: Pool, redis: Redis) {
  await pool.query('TRUNCATE events, sections, outbox CASCADE')
  await redis.flushdb()
}

export function makeApp(pool: Pool, redis: Redis) {
  return buildApp(testConfig(), { pool, redis, verifyToken })
}

export const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

export const eventInput = (overrides: Record<string, unknown> = {}) => ({
  title: 'Recital de prueba',
  venueName: 'Estadio Central',
  city: 'Rosario',
  startsAt: daysFromNow(30),
  sections: [
    { name: 'Campo', priceCents: 50_000_00, rows: 10, seatsPerRow: 20 },
    { name: 'Platea', priceCents: 80_000_00, rows: 5, seatsPerRow: 10 },
  ],
  ...overrides,
})
