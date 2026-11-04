import { fileURLToPath } from 'node:url'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool, runMigrations, type Pool } from '@ticketflow/common'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { loadSigningKeys, type SigningKeys } from '../src/keys'

type App = Awaited<ReturnType<typeof buildApp>>

let pool: Pool
let keys: SigningKeys
let app: App

const makeApp = (overrides: Record<string, string> = {}) =>
  buildApp(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      RABBITMQ_URL: 'amqp://unused',
      LOGIN_RATE_LIMIT_MAX: '1000',
      ...overrides,
    }),
    { pool, keys },
  )

beforeAll(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL!)
  await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), { info() {} })
  keys = await loadSigningKeys()
})

beforeEach(async () => {
  await pool.query('TRUNCATE users, refresh_tokens, outbox CASCADE')
  app = await makeApp()
})

afterEach(async () => {
  await app.close()
})

afterAll(async () => {
  await pool.end()
})

const register = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/auth/register', payload: body })
const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })
const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } })

const USER = { email: 'ana@example.com', password: 'contraseña-segura' }

describe('registro', () => {
  it('crea la cuenta y devuelve una sesión sin exponer el hash', async () => {
    const res = await register(USER)

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.user).toMatchObject({ email: USER.email, role: 'customer' })
    expect(body.user).not.toHaveProperty('passwordHash')
    expect(body.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 })

    const { rows } = await pool.query('SELECT password_hash FROM users')
    expect(rows[0].password_hash).toMatch(/^scrypt\$/)
    expect(rows[0].password_hash).not.toContain(USER.password)
  })

  it('publica user.registered (vía outbox) en el mismo commit que crea la cuenta', async () => {
    const { user } = (await register(USER)).json()
    const { rows } = await pool.query('SELECT type, payload FROM outbox')

    expect(rows).toEqual([
      { type: 'user.registered', payload: { userId: user.id, email: USER.email, role: 'customer' } },
    ])
  })

  it('un registro fallido no publica nada', async () => {
    await register(USER)
    await register(USER) // email duplicado: rollback
    expect((await pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(1)
  })

  it('rechaza emails duplicados sin importar mayúsculas', async () => {
    await register(USER)
    const res = await register({ ...USER, email: 'ANA@Example.com' })

    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('EMAIL_TAKEN')
  })

  it('valida el body', async () => {
    const res = await register({ email: 'no-es-un-email', password: 'corta' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('no permite autoasignarse el rol admin', async () => {
    const res = await register({ ...USER, role: 'admin' })
    expect(res.statusCode).toBe(400)
  })

  it('permite registrarse como organizador', async () => {
    const res = await register({ ...USER, role: 'organizer' })
    expect(res.json().user.role).toBe('organizer')
  })
})

describe('login', () => {
  beforeEach(async () => {
    await register(USER)
  })

  it('devuelve tokens con credenciales correctas', async () => {
    const res = await login(USER.email, USER.password)
    expect(res.statusCode).toBe(200)
    expect(res.json().tokens.accessToken).toBeTypeOf('string')
  })

  it('responde igual ante contraseña incorrecta y email inexistente', async () => {
    const wrongPassword = await login(USER.email, 'otra-contraseña')
    const unknownEmail = await login('nadie@example.com', USER.password)

    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownEmail.statusCode).toBe(401)
    expect(wrongPassword.json()).toEqual(unknownEmail.json())
  })

  it('limita intentos por IP', async () => {
    await app.close()
    app = await makeApp({ LOGIN_RATE_LIMIT_MAX: '3' })

    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await login(USER.email, 'mal-password')).statusCode)

    expect(statuses).toEqual([401, 401, 401, 429])
  })

  const loginFrom = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': ip },
      payload: { email: USER.email, password: 'mal-password' },
    })

  it('detrás del gateway (TRUST_PROXY) limita por la IP real de cada cliente', async () => {
    await app.close()
    app = await makeApp({ LOGIN_RATE_LIMIT_MAX: '2', TRUST_PROXY: 'true' })

    await loginFrom('203.0.113.1')
    await loginFrom('203.0.113.1')
    expect((await loginFrom('203.0.113.1')).statusCode).toBe(429)
    expect((await loginFrom('203.0.113.2')).statusCode).toBe(401) // otro cliente, no bloqueado
  })

  it('sin TRUST_PROXY, falsificar X-Forwarded-For no saltea el límite', async () => {
    await app.close()
    app = await makeApp({ LOGIN_RATE_LIMIT_MAX: '2' })

    await loginFrom('203.0.113.1')
    await loginFrom('203.0.113.2')
    expect((await loginFrom('203.0.113.3')).statusCode).toBe(429)
  })
})

describe('access token', () => {
  it('permite consultar /auth/me', async () => {
    const { tokens } = (await register(USER)).json()
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().email).toBe(USER.email)
  })

  it('rechaza requests sin token o con token adulterado', async () => {
    const { tokens } = (await register(USER)).json()
    const [header, payload, signature] = tokens.accessToken.split('.')
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), role: 'admin' }),
    ).toString('base64url')

    const missing = await app.inject({ method: 'GET', url: '/auth/me' })
    const forged = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${header}.${forgedPayload}.${signature}` },
    })

    expect(missing.json().error.code).toBe('MISSING_TOKEN')
    expect(forged.statusCode).toBe(401)
    expect(forged.json().error.code).toBe('INVALID_TOKEN')
  })

  it('otros servicios pueden validarlo usando solo el JWKS público', async () => {
    const { user, tokens } = (await register(USER)).json()
    const jwks = (await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json()

    expect(jwks.keys[0]).not.toHaveProperty('d') // nunca exponer la parte privada
    const { payload } = await jwtVerify(tokens.accessToken, createLocalJWKSet(jwks), {
      issuer: 'ticketflow-auth',
      audience: 'ticketflow',
    })
    expect(payload).toMatchObject({ sub: user.id, role: 'customer' })
  })
})

describe('refresh tokens', () => {
  it('rota el token: el nuevo funciona y es distinto', async () => {
    const { tokens } = (await register(USER)).json()
    const res = await refresh(tokens.refreshToken)

    expect(res.statusCode).toBe(200)
    expect(res.json().refreshToken).not.toBe(tokens.refreshToken)
    expect((await refresh(res.json().refreshToken)).statusCode).toBe(200)
  })

  it('si se reutiliza un token rotado, revoca toda la sesión', async () => {
    const { tokens } = (await register(USER)).json()
    const rotated = (await refresh(tokens.refreshToken)).json()

    // Un atacante usa el token viejo que robó...
    const reuse = await refresh(tokens.refreshToken)
    expect(reuse.statusCode).toBe(401)
    expect(reuse.json().error.code).toBe('REFRESH_TOKEN_REUSED')

    // ...y el token legítimo más reciente también queda invalidado.
    expect((await refresh(rotated.refreshToken)).statusCode).toBe(401)
  })

  it('dos refresh simultáneos con el mismo token: solo uno gana', async () => {
    const { tokens } = (await register(USER)).json()
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(tokens.refreshToken)))
    const statuses = results.map((r) => r.statusCode).sort()

    expect(statuses).toEqual([200, 401, 401, 401, 401])
  })

  it('una sesión revocada no afecta a otras sesiones del mismo usuario', async () => {
    const phone = (await register(USER)).json().tokens
    const laptop = (await login(USER.email, USER.password)).json().tokens

    await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: phone.refreshToken } })

    expect((await refresh(phone.refreshToken)).statusCode).toBe(401)
    expect((await refresh(laptop.refreshToken)).statusCode).toBe(200)
  })

  it('rechaza tokens expirados', async () => {
    const { tokens } = (await register(USER)).json()
    await pool.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second'`)

    const res = await refresh(tokens.refreshToken)
    expect(res.json().error.code).toBe('REFRESH_TOKEN_EXPIRED')
  })

  it('logout responde 204 aunque el token no exista', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'inexistente' },
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })
})

describe('operación', () => {
  it('readiness verifica la base de datos', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } })
  })

  it('propaga el x-request-id recibido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'req-123' },
    })
    expect(res.headers['x-request-id']).toBe('req-123')
  })

  it('devuelve 404 con formato de error uniforme', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-existe' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND')
  })
})
