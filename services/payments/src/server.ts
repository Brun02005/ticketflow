import { fileURLToPath } from 'node:url'
import {
  OutboxRelay,
  PeriodicTask,
  RabbitConsumer,
  RabbitPublisher,
  createPool,
  createTokenVerifier,
  remoteJwks,
  runMigrations,
  startServer,
} from '@ticketflow/common'
import { buildApp } from './app'
import { loadConfig } from './config'
import { registerBusinessMetrics } from './metrics'
import { dispatchRefunds, reconcileCharges } from './reconciler'
import { handleOrderMessage } from './saga'

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

const consumer = await RabbitConsumer.start(
  config.RABBITMQ_URL,
  {
    queue: config.RABBITMQ_QUEUE,
    bindings: ['order.created', 'order.expired', 'order.cancelled', 'order.payment_rejected'],
  },
  (event) => handleOrderMessage(pool, event, app.log),
  app.log,
)
const publisher = await RabbitPublisher.connect(config.RABBITMQ_URL, app.log)
const relay = new OutboxRelay(pool, publisher, app.log)
const reconciler = new PeriodicTask(
  'conciliar-pagos',
  config.RECONCILE_INTERVAL_MS,
  async () => {
    await reconcileCharges(pool, app.psp, config.RECONCILE_AFTER_SECONDS, app.log)
    await dispatchRefunds(pool, app.psp, config.PUBLIC_WEBHOOK_URL, config.RECONCILE_AFTER_SECONDS, app.log)
  },
  app.log,
)
relay.start()
reconciler.start()

app.addHook('onClose', async () => {
  await consumer.close()
  await reconciler.stop()
  await relay.stop()
  await publisher.close()
  await pool.end()
})

await startServer(app, config.PORT)
