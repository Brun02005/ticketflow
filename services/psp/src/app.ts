import { timingSafeEqual } from 'node:crypto'
import {
  AppError,
  Type,
  UnauthorizedError,
  createHttpApp,
  loadEnv,
  type FastifyPluginAsyncTypebox,
  type Static,
} from '@ticketflow/common'
import { PaymentProvider, TEST_CARDS } from './provider'

export const PspEnv = Type.Object({
  PORT: Type.Integer({ default: 4000 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  PSP_API_KEY: Type.String({ minLength: 8, default: 'sk_test_ticketflow' }),
  PSP_WEBHOOK_SECRET: Type.String({ minLength: 8, default: 'whsec_dev_ticketflow' }),
  /** Demora simulada entre el cobro y su resultado. */
  PSP_MIN_DELAY_MS: Type.Integer({ default: 300, minimum: 0 }),
  PSP_MAX_DELAY_MS: Type.Integer({ default: 1500, minimum: 0 }),
  PSP_WEBHOOK_MAX_ATTEMPTS: Type.Integer({ default: 6, minimum: 1 }),
  PSP_WEBHOOK_RETRY_BASE_MS: Type.Integer({ default: 1000, minimum: 1 }),
  /** Probabilidad (0 a 1) de responder 503 a un POST: simula una pasarela inestable. */
  PSP_ERROR_RATE: Type.Number({ default: 0, minimum: 0, maximum: 1 }),
})
export type PspConfig = Static<typeof PspEnv>
export const loadConfig = (source?: Record<string, string | undefined>) => loadEnv(PspEnv, source)

const sameSecret = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export async function buildApp(config: PspConfig) {
  const app = createHttpApp({ serviceName: 'psp-simulator', logLevel: config.LOG_LEVEL })
  const provider = new PaymentProvider(
    {
      webhookSecret: config.PSP_WEBHOOK_SECRET,
      minDelayMs: config.PSP_MIN_DELAY_MS,
      maxDelayMs: Math.max(config.PSP_MIN_DELAY_MS, config.PSP_MAX_DELAY_MS),
      webhookMaxAttempts: config.PSP_WEBHOOK_MAX_ATTEMPTS,
      webhookRetryBaseMs: config.PSP_WEBHOOK_RETRY_BASE_MS,
    },
    app.log,
  )
  app.addHook('onClose', async () => provider.shutdown())

  const IdempotencyHeaders = Type.Object({ 'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }) })

  // API autenticada con API key, como la de cualquier pasarela.
  const v1: FastifyPluginAsyncTypebox = async (api) => {
    api.addHook('onRequest', async (req) => {
      const key = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      if (!sameSecret(key, config.PSP_API_KEY)) throw new UnauthorizedError('INVALID_API_KEY', 'API key inválida')
      if (req.method === 'POST' && Math.random() < config.PSP_ERROR_RATE) {
        throw new AppError(503, 'PSP_UNAVAILABLE', '[simulación] pasarela temporalmente no disponible')
      }
    })

    api.post(
      '/v1/charges',
      {
        schema: {
          headers: IdempotencyHeaders,
          body: Type.Object({
            amount: Type.Integer({ minimum: 1 }),
            currency: Type.String({ minLength: 3, maxLength: 3 }),
            reference: Type.String({ minLength: 1, maxLength: 100 }),
            cardNumber: Type.String({ pattern: '^[0-9]{12,19}$' }),
            webhookUrl: Type.String({ minLength: 1 }),
          }),
        },
      },
      async (req, reply) => reply.status(202).send(provider.createCharge(req.headers['idempotency-key'], req.body)),
    )

    api.get('/v1/charges', { schema: { querystring: Type.Object({ reference: Type.Optional(Type.String()) }) } }, async (req) => ({
      data: req.query.reference ? provider.findCharges(req.query.reference) : provider.listCharges(),
    }))

    api.get('/v1/charges/:id', { schema: { params: Type.Object({ id: Type.String() }) } }, async (req) =>
      provider.getCharge(req.params.id),
    )

    api.post(
      '/v1/refunds',
      {
        schema: {
          headers: IdempotencyHeaders,
          body: Type.Object({ charge: Type.String(), webhookUrl: Type.String({ minLength: 1 }) }),
        },
      },
      async (req, reply) => reply.status(202).send(provider.createRefund(req.headers['idempotency-key'], req.body)),
    )
  }
  await app.register(v1)

  // Documentación pública de las tarjetas de prueba.
  app.get('/test-cards', async () =>
    Object.entries(TEST_CARDS).map(([number, { description }]) => ({ number, description })),
  )

  return Object.assign(app, { provider })
}
