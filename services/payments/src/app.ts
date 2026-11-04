import helmet from '@fastify/helmet'
import { createHttpApp, type Pool, registerDocs, type TokenVerifier } from '@ticketflow/common'
import type { PaymentsConfig } from './config'
import { PaymentsService } from './payments'
import { PspClient } from './psp-client'
import { paymentRoutes, webhookRoutes } from './routes'

export interface PaymentsDeps {
  pool: Pool
  verifyToken: TokenVerifier
  psp?: PspClient
}

export async function buildApp(config: PaymentsConfig, deps: PaymentsDeps) {
  const app = createHttpApp({
    serviceName: 'payments-service',
    logLevel: config.LOG_LEVEL,
    readinessChecks: { postgres: () => deps.pool.query('SELECT 1') },
  })

  await app.register(helmet)
  await registerDocs(app, { title: 'TicketFlow · Payments Service', version: '0.1.0' })

  const psp = deps.psp ?? new PspClient({ baseUrl: config.PSP_URL, apiKey: config.PSP_API_KEY })
  const service = new PaymentsService(deps.pool, psp, { webhookUrl: config.PUBLIC_WEBHOOK_URL }, app.log)

  await app.register(paymentRoutes, { service, verifyToken: deps.verifyToken })
  await app.register(webhookRoutes, { pool: deps.pool, secret: config.PSP_WEBHOOK_SECRET })

  return Object.assign(app, { psp })
}
