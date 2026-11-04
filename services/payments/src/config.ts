import { loadEnv, type Static, Type } from '@ticketflow/common'

export const PaymentsEnv = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('production'), Type.Literal('test')], {
    default: 'development',
  }),
  PORT: Type.Integer({ default: 3004 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  RABBITMQ_URL: Type.String({ minLength: 1 }),
  RABBITMQ_QUEUE: Type.String({ default: 'payments.events' }),
  AUTH_JWKS_URL: Type.String({ minLength: 1 }),
  JWT_ISSUER: Type.String({ default: 'ticketflow-auth' }),
  JWT_AUDIENCE: Type.String({ default: 'ticketflow' }),
  PSP_URL: Type.String({ minLength: 1 }),
  PSP_API_KEY: Type.String({ minLength: 8 }),
  PSP_WEBHOOK_SECRET: Type.String({ minLength: 8 }),
  /** URL pública a la que la pasarela manda los webhooks (en general, a través del gateway). */
  PUBLIC_WEBHOOK_URL: Type.String({ minLength: 1 }),
  /** Cada cuánto corre la conciliación con la pasarela y el envío de reembolsos. */
  RECONCILE_INTERVAL_MS: Type.Integer({ default: 10_000, minimum: 100 }),
  /** Un cobro sin respuesta durante este tiempo se consulta activamente a la pasarela. */
  RECONCILE_AFTER_SECONDS: Type.Integer({ default: 60, minimum: 0 }),
})

export type PaymentsConfig = Static<typeof PaymentsEnv>

export const loadConfig = (source?: Record<string, string | undefined>) => loadEnv(PaymentsEnv, source)
