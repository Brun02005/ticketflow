import { Type, loadEnv, type Static } from '@ticketflow/common'

export const AuthEnv = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('production'), Type.Literal('test')],
    { default: 'development' },
  ),
  PORT: Type.Integer({ default: 3001 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  /** Ver parseTrustProxy en @ticketflow/common. */
  TRUST_PROXY: Type.Optional(Type.String()),
  DATABASE_URL: Type.String({ minLength: 1 }),
  /** Clave privada Ed25519 en PEM (PKCS#8). Obligatoria en producción. */
  JWT_PRIVATE_KEY: Type.Optional(Type.String({ minLength: 1 })),
  JWT_ISSUER: Type.String({ default: 'ticketflow-auth' }),
  JWT_AUDIENCE: Type.String({ default: 'ticketflow' }),
  ACCESS_TOKEN_TTL_SECONDS: Type.Integer({ default: 900, minimum: 60 }),
  REFRESH_TOKEN_TTL_DAYS: Type.Integer({ default: 30, minimum: 1 }),
  LOGIN_RATE_LIMIT_MAX: Type.Integer({ default: 10, minimum: 1 }),
})

export type AuthConfig = Static<typeof AuthEnv>

export function loadConfig(source?: Record<string, string | undefined>): AuthConfig {
  const config = loadEnv(AuthEnv, source)
  if (config.NODE_ENV === 'production' && !config.JWT_PRIVATE_KEY) {
    throw new Error('JWT_PRIVATE_KEY es obligatoria en producción (generala con `npm run keys -w @ticketflow/auth-service`)')
  }
  return config
}
