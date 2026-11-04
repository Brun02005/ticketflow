import helmet from '@fastify/helmet'
import { createHttpApp, registerDocs, type Pool, type Redis, type TokenVerifier } from '@ticketflow/common'
import { EventCache } from './cache'
import type { EventsConfig } from './config'
import { eventsRoutes } from './routes'
import { EventsService } from './service'

export interface EventsDeps {
  pool: Pool
  redis: Redis
  verifyToken: TokenVerifier
}

export async function buildApp(config: EventsConfig, deps: EventsDeps) {
  const app = createHttpApp({
    serviceName: 'events-service',
    logLevel: config.LOG_LEVEL,
    // RabbitMQ no está en readiness a propósito: gracias al outbox, el servicio
    // sigue atendiendo aunque el broker esté caído.
    readinessChecks: {
      postgres: () => deps.pool.query('SELECT 1'),
      redis: () => deps.redis.ping(),
    },
  })

  await app.register(helmet)
  await registerDocs(app, { title: 'TicketFlow · Events Service', version: '0.1.0' })

  const cache = new EventCache(deps.redis, config.EVENT_CACHE_TTL_SECONDS, app.log)
  const service = new EventsService(deps.pool, cache)
  await app.register(eventsRoutes, { service, verifyToken: deps.verifyToken })

  return app
}
