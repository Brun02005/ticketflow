import { fileURLToPath } from 'node:url'
import {
  createPool,
  createRedis,
  createTokenVerifier,
  OutboxRelay,
  RabbitPublisher,
  remoteJwks,
  runMigrations,
  startServer,
} from '@ticketflow/common'
import { buildApp } from './app'
import { loadConfig } from './config'
import { registerBusinessMetrics } from './metrics'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
const redis = createRedis(config.REDIS_URL)
const verifyToken = createTokenVerifier({
  key: remoteJwks(config.AUTH_JWKS_URL),
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
})

const app = await buildApp(config, { pool, redis, verifyToken })
redis.on('error', (err) => app.log.warn({ err: err.message }, 'error de Redis'))

await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), app.log)
registerBusinessMetrics(pool)

// El relay del outbox corre en el mismo proceso. Con SKIP LOCKED se puede
// escalar a varias réplicas, o moverlo a un worker separado sin cambiar código.
const publisher = await RabbitPublisher.connect(config.RABBITMQ_URL, app.log)
const relay = new OutboxRelay(pool, publisher, app.log)
relay.start()

app.addHook('onClose', async () => {
  await relay.stop()
  await publisher.close()
  redis.disconnect()
  await pool.end()
})

await startServer(app, config.PORT)
