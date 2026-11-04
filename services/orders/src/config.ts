import { Type, loadEnv, type Static } from '@ticketflow/common'

export const OrdersEnv = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('production'), Type.Literal('test')],
    { default: 'development' },
  ),
  PORT: Type.Integer({ default: 3003 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  RABBITMQ_URL: Type.String({ minLength: 1 }),
  /** Cola propia del servicio. Se puede cambiar para aislar tests. */
  RABBITMQ_QUEUE: Type.String({ default: 'orders.events' }),
  AUTH_JWKS_URL: Type.String({ minLength: 1 }),
  JWT_ISSUER: Type.String({ default: 'ticketflow-auth' }),
  JWT_AUDIENCE: Type.String({ default: 'ticketflow' }),
  /** Cuánto tiempo quedan reservados los asientos esperando el pago. */
  HOLD_TTL_SECONDS: Type.Integer({ default: 600, minimum: 1 }),
  MAX_SEATS_PER_ORDER: Type.Integer({ default: 10, minimum: 1, maximum: 50 }),
  EXPIRER_INTERVAL_MS: Type.Integer({ default: 5000, minimum: 100 }),
  /** Horas que se guarda una Idempotency-Key antes de poder reutilizarse. */
  IDEMPOTENCY_TTL_HOURS: Type.Integer({ default: 24, minimum: 1 }),
})

export type OrdersConfig = Static<typeof OrdersEnv>

export const loadConfig = (source?: Record<string, string | undefined>) => loadEnv(OrdersEnv, source)
