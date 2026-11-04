import { fileURLToPath } from 'node:url'
import {
  createPool,
  createTokenVerifier,
  OutboxRelay,
  PeriodicTask,
  RabbitConsumer,
  RabbitPublisher,
  remoteJwks,
  runMigrations,
  startServer,
} from '@ticketflow/common'
import { buildApp } from './app'
import { loadConfig } from './config'
import { expireOrders, purgeIdempotencyKeys } from './expirer'
import { registerBusinessMetrics } from './metrics'
import { handleDomainEvent } from './projection'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
const verifyToken = createTokenVerifier({
  key: remoteJwks(config.AUTH_JWKS_URL),
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
})

const app = await buildApp(config, { pool, verifyToken })
await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), app.log)
registerBusinessMetrics(pool)

// Un mismo proceso corre la API y tres trabajos en segundo plano. Todos son
// seguros con varias réplicas, así que se podrían separar en workers propios.
const consumer = await RabbitConsumer.start(
  config.RABBITMQ_URL,
  { queue: config.RABBITMQ_QUEUE, bindings: ['event.published', 'event.cancelled', 'payment.succeeded'] },
  (event) => handleDomainEvent(pool, event, app.log),
  app.log,
)
const publisher = await RabbitPublisher.connect(config.RABBITMQ_URL, app.log)
const relay = new OutboxRelay(pool, publisher, app.log)
const expirer = new PeriodicTask(
  'expirar-ordenes',
  config.EXPIRER_INTERVAL_MS,
  async () => {
    const expired = await expireOrders(pool)
    if (expired > 0) app.log.info({ expired }, 'órdenes vencidas, asientos liberados')
    await purgeIdempotencyKeys(pool, config.IDEMPOTENCY_TTL_HOURS)
  },
  app.log,
)
relay.start()
expirer.start()

app.addHook('onClose', async () => {
  await consumer.close()
  await expirer.stop()
  await relay.stop()
  await publisher.close()
  await pool.end()
})

await startServer(app, config.PORT)
