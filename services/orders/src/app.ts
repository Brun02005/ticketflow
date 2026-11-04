import helmet from '@fastify/helmet'
import { createHttpApp, type Pool, registerDocs, type TokenVerifier } from '@ticketflow/common'
import type { OrdersConfig } from './config'
import { ordersRoutes } from './routes'
import { OrdersService } from './service'

export interface OrdersDeps {
  pool: Pool
  verifyToken: TokenVerifier
}

export async function buildApp(config: OrdersConfig, deps: OrdersDeps) {
  const app = createHttpApp({
    serviceName: 'orders-service',
    logLevel: config.LOG_LEVEL,
    readinessChecks: { postgres: () => deps.pool.query('SELECT 1') },
  })

  await app.register(helmet)
  await registerDocs(app, { title: 'TicketFlow · Orders Service', version: '0.1.0' })

  const service = new OrdersService(deps.pool, {
    holdSeconds: config.HOLD_TTL_SECONDS,
    maxSeatsPerOrder: config.MAX_SEATS_PER_ORDER,
  })
  await app.register(ordersRoutes, { service, verifyToken: deps.verifyToken })

  return app
}
