import { createRedis, createTokenVerifier, remoteJwks, startServer } from '@ticketflow/common'
import { buildApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const redis = createRedis(config.REDIS_URL)
const verifyToken = createTokenVerifier({
  key: remoteJwks(config.AUTH_JWKS_URL),
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
})

const app = await buildApp(config, { redis, verifyToken })
redis.on('error', (err) => app.log.warn({ err: err.message }, 'error de Redis'))

app.addHook('onClose', async () => {
  redis.disconnect()
})

await startServer(app, config.PORT)
