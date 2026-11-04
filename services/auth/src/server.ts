import { fileURLToPath } from 'node:url'
import { OutboxRelay, RabbitPublisher, createPool, runMigrations, startServer } from '@ticketflow/common'
import { buildApp } from './app'
import { loadConfig } from './config'
import { loadSigningKeys } from './keys'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
const keys = await loadSigningKeys(config.JWT_PRIVATE_KEY)
const app = await buildApp(config, { pool, keys })

if (!config.JWT_PRIVATE_KEY) {
  app.log.warn(
    'JWT_PRIVATE_KEY no está definida: se generó una clave efímera. Los tokens dejan de valer al reiniciar.',
  )
}

await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), app.log)

const publisher = await RabbitPublisher.connect(config.RABBITMQ_URL, app.log)
const relay = new OutboxRelay(pool, publisher, app.log)
relay.start()

app.addHook('onClose', async () => {
  await relay.stop()
  await publisher.close()
  await pool.end()
})

await startServer(app, config.PORT)
