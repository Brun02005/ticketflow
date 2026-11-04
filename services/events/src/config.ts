import { loadEnv, type Static, Type } from '@ticketflow/common'

export const EventsEnv = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('production'), Type.Literal('test')], {
    default: 'development',
  }),
  PORT: Type.Integer({ default: 3002 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  REDIS_URL: Type.String({ minLength: 1 }),
  RABBITMQ_URL: Type.String({ minLength: 1 }),
  /** JWKS de auth-service, para validar access tokens sin compartir secretos. */
  AUTH_JWKS_URL: Type.String({ minLength: 1 }),
  JWT_ISSUER: Type.String({ default: 'ticketflow-auth' }),
  JWT_AUDIENCE: Type.String({ default: 'ticketflow' }),
  EVENT_CACHE_TTL_SECONDS: Type.Integer({ default: 60, minimum: 1 }),
})

export type EventsConfig = Static<typeof EventsEnv>

export const loadConfig = (source?: Record<string, string | undefined>) => loadEnv(EventsEnv, source)
