import { fileURLToPath } from 'node:url'
import {
  PeriodicTask,
  RabbitConsumer,
  createPool,
  createTokenVerifier,
  remoteJwks,
  runMigrations,
  startServer,
} from '@ticketflow/common'
import { buildApp } from './app'
import { loadConfig } from './config'
import { dispatchDue } from './dispatcher'
import { BINDINGS, handleMessage } from './handlers'
import { createSmtpMailer } from './mailer'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
const verifyToken = createTokenVerifier({
  key: remoteJwks(config.AUTH_JWKS_URL),
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
})

const app = await buildApp(config, { pool, verifyToken })
await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), app.log)

const consumer = await RabbitConsumer.start(
  config.RABBITMQ_URL,
  { queue: config.RABBITMQ_QUEUE, bindings: BINDINGS },
  (event) => handleMessage(pool, event, app.log),
  app.log,
)

const mailer = createSmtpMailer({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  user: config.SMTP_USER,
  pass: config.SMTP_PASS,
  from: config.MAIL_FROM,
})
const dispatcher = new PeriodicTask(
  'enviar-notificaciones',
  config.DISPATCH_INTERVAL_MS,
  async () => {
    const result = await dispatchDue(
      pool,
      mailer,
      {
        maxAttempts: config.MAX_ATTEMPTS,
        retryBaseSeconds: config.RETRY_BASE_SECONDS,
        timezone: config.TIMEZONE,
        ticketSecret: config.TICKET_SIGNING_SECRET,
      },
      app.log,
    )
    if (result.sent + result.retried + result.failed > 0) app.log.info(result, 'despacho de notificaciones')
  },
  app.log,
)
dispatcher.start()

app.addHook('onClose', async () => {
  await consumer.close()
  await dispatcher.stop()
  mailer.close()
  await pool.end()
})

await startServer(app, config.PORT)
