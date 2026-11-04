import { Type, loadEnv, type Static } from '@ticketflow/common'

export const GatewayEnv = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('production'), Type.Literal('test')],
    { default: 'development' },
  ),
  PORT: Type.Integer({ default: 3000 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  /** Ver parseTrustProxy en @ticketflow/common. */
  TRUST_PROXY: Type.Optional(Type.String()),
  REDIS_URL: Type.String({ minLength: 1 }),
  AUTH_SERVICE_URL: Type.String({ minLength: 1 }),
  EVENTS_SERVICE_URL: Type.String({ minLength: 1 }),
  ORDERS_SERVICE_URL: Type.String({ minLength: 1 }),
  PAYMENTS_SERVICE_URL: Type.String({ minLength: 1 }),
  /** Por defecto: <AUTH_SERVICE_URL>/.well-known/jwks.json */
  AUTH_JWKS_URL: Type.Optional(Type.String({ minLength: 1 })),
  JWT_ISSUER: Type.String({ default: 'ticketflow-auth' }),
  JWT_AUDIENCE: Type.String({ default: 'ticketflow' }),
  /** Requests permitidas por ventana, por usuario autenticado o por IP si es anónimo. */
  RATE_LIMIT_MAX: Type.Integer({ default: 300, minimum: 1 }),
  RATE_LIMIT_WINDOW_MS: Type.Integer({ default: 60_000, minimum: 1000 }),
  /** Orígenes permitidos para CORS, separados por coma. "*" permite cualquiera. */
  CORS_ORIGINS: Type.String({ default: '*' }),
  UPSTREAM_TIMEOUT_MS: Type.Integer({ default: 10_000, minimum: 100 }),
})

export type GatewayConfig = Static<typeof GatewayEnv> & { AUTH_JWKS_URL: string }

export function loadConfig(source?: Record<string, string | undefined>): GatewayConfig {
  const config = loadEnv(GatewayEnv, source)
  return {
    ...config,
    AUTH_JWKS_URL: config.AUTH_JWKS_URL ?? `${config.AUTH_SERVICE_URL}/.well-known/jwks.json`,
  }
}
