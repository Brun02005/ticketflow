import { loadEnv, type Static, Type } from '@ticketflow/common'

export const NotificationsEnv = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('production'), Type.Literal('test')], {
    default: 'development',
  }),
  PORT: Type.Integer({ default: 3005 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  RABBITMQ_URL: Type.String({ minLength: 1 }),
  RABBITMQ_QUEUE: Type.String({ default: 'notifications.events' }),
  AUTH_JWKS_URL: Type.String({ minLength: 1 }),
  JWT_ISSUER: Type.String({ default: 'ticketflow-auth' }),
  JWT_AUDIENCE: Type.String({ default: 'ticketflow' }),
  SMTP_HOST: Type.String({ minLength: 1 }),
  SMTP_PORT: Type.Integer({ default: 1025 }),
  SMTP_SECURE: Type.Boolean({ default: false }),
  SMTP_USER: Type.Optional(Type.String()),
  SMTP_PASS: Type.Optional(Type.String()),
  MAIL_FROM: Type.String({ default: 'TicketFlow <entradas@ticketflow.test>' }),
  /** Secreto con el que se firman los códigos QR de las entradas. */
  TICKET_SIGNING_SECRET: Type.String({ minLength: 16 }),
  DISPATCH_INTERVAL_MS: Type.Integer({ default: 2000, minimum: 50 }),
  /** Intentos de envío antes de marcar la notificación como fallida. */
  MAX_ATTEMPTS: Type.Integer({ default: 8, minimum: 1 }),
  /** Base del backoff exponencial entre reintentos: base * 2^(intento - 1). */
  RETRY_BASE_SECONDS: Type.Integer({ default: 10, minimum: 1 }),
  TIMEZONE: Type.String({ default: 'America/Argentina/Buenos_Aires' }),
})

export type NotificationsConfig = Static<typeof NotificationsEnv>

export const loadConfig = (source?: Record<string, string | undefined>) => loadEnv(NotificationsEnv, source)
