import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { createHttpApp, type Pool, parseTrustProxy, registerDocs } from '@ticketflow/common'
import type { AuthConfig } from './config'
import type { SigningKeys } from './keys'
import { authRoutes } from './routes'
import { AuthService } from './service'
import { TokenIssuer } from './tokens'

export interface AuthDeps {
  pool: Pool
  keys: SigningKeys
}

/**
 * Construye la app sin levantarla. Recibe sus dependencias desde afuera
 * (pool, claves) para que los tests puedan armarla con una base de prueba.
 */
export async function buildApp(config: AuthConfig, deps: AuthDeps) {
  const app = createHttpApp({
    serviceName: 'auth-service',
    logLevel: config.LOG_LEVEL,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    readinessChecks: { postgres: () => deps.pool.query('SELECT 1') },
  })

  await app.register(helmet)
  await app.register(rateLimit, { global: false })

  await registerDocs(app, { title: 'TicketFlow · Auth Service', version: '0.1.0' })

  const tokens = new TokenIssuer(deps.keys, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  })
  const service = new AuthService(deps.pool, tokens, { refreshTtlDays: config.REFRESH_TOKEN_TTL_DAYS })

  await app.register(authRoutes, { service, tokens, loginRateLimitMax: config.LOGIN_RATE_LIMIT_MAX })

  return app
}
