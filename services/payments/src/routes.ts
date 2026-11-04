import {
  BadRequestError,
  type FastifyPluginAsyncTypebox,
  type Pool,
  requireAuth,
  type TokenVerifier,
  Type,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  withTransaction,
} from '@ticketflow/common'
import type { FastifyPluginAsync } from 'fastify'
import { applyChargeResult, type PaymentsService } from './payments'
import { applyRefundSucceeded } from './reconciler'

const ErrorRef = { $ref: 'ErrorResponse#' }

const PaymentView = Type.Object({
  payment: Type.Object({
    id: Type.String(),
    orderId: Type.String(),
    amountCents: Type.Integer(),
    currency: Type.String(),
    status: Type.String(),
    expiresAt: Type.String({ format: 'date-time' }),
  }),
  charges: Type.Array(
    Type.Object({
      id: Type.String(),
      status: Type.String(),
      cardLast4: Type.String(),
      failureReason: Type.Union([Type.String(), Type.Null()]),
      createdAt: Type.String({ format: 'date-time' }),
    }),
  ),
})

export const paymentRoutes: FastifyPluginAsyncTypebox<{
  service: PaymentsService
  verifyToken: TokenVerifier
}> = async (app, { service, verifyToken }) => {
  const authenticated = requireAuth(verifyToken)
  const OrderParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) })

  app.get(
    '/payments/:orderId',
    {
      onRequest: authenticated,
      schema: {
        tags: ['pagos'],
        summary: 'Estado del pago de una orden',
        security: [{ bearerAuth: [] }],
        params: OrderParams,
        response: { 200: PaymentView, 404: ErrorRef },
      },
    },
    async (req) => service.get(req.auth!, req.params.orderId),
  )

  app.post(
    '/payments/:orderId/pay',
    {
      onRequest: authenticated,
      schema: {
        tags: ['pagos'],
        summary: 'Pagar una orden con tarjeta',
        description:
          'El cobro es asincrónico: responde 202 con el pago en "processing" y el resultado llega por webhook. ' +
          'Tarjetas de prueba en GET /test-cards de la pasarela simulada.',
        security: [{ bearerAuth: [] }],
        params: OrderParams,
        body: Type.Object({ cardNumber: Type.String({ pattern: '^[0-9]{12,19}$' }) }),
        response: { 202: PaymentView, 404: ErrorRef, 409: ErrorRef },
      },
    },
    async (req, reply) => reply.status(202).send(await service.pay(req.auth!, req.params.orderId, req.body.cardNumber)),
  )
}

interface PspWebhookEvent {
  id: string
  type: string
  data: {
    id: string
    reference: string
    amount: number
    currency: string
    status: 'succeeded' | 'failed'
    failureReason: string | null
  }
}

/**
 * Receptor de webhooks de la pasarela. Va en su propio plugin porque necesita
 * el body crudo (sin parsear) para verificar la firma HMAC.
 */
export const webhookRoutes: FastifyPluginAsync<{ pool: Pool; secret: string }> = async (app, { pool, secret }) => {
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))

  app.post(
    '/webhooks/psp',
    { schema: { tags: ['pagos'], summary: 'Webhook de la pasarela (firmado)' } },
    async (req) => {
      const raw = req.body as string
      const verification = verifyWebhookSignature(
        secret,
        req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined,
        raw,
      )
      if (!verification.ok) {
        req.log.warn({ reason: verification.reason }, 'webhook rechazado')
        throw new BadRequestError(verification.reason, 'Firma del webhook inválida')
      }

      let event: PspWebhookEvent
      try {
        event = JSON.parse(raw) as PspWebhookEvent
      } catch {
        throw new BadRequestError('INVALID_JSON', 'Body inválido')
      }

      const isNew = await withTransaction(pool, async (tx) => {
        // Deduplicación por id del evento, en la misma transacción que el efecto.
        const { rowCount } = await tx.query(
          `INSERT INTO webhook_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [event.id, event.type],
        )
        if (rowCount === 0) return false

        switch (event.type) {
          case 'charge.succeeded':
          case 'charge.failed':
            await applyChargeResult(
              tx,
              {
                reference: event.data.reference,
                pspChargeId: event.data.id,
                status: event.data.status,
                amount: event.data.amount,
                currency: event.data.currency,
                failureReason: event.data.failureReason,
              },
              req.log,
            )
            break
          case 'refund.succeeded':
            await applyRefundSucceeded(tx, event.data.reference, req.log)
            break
        }
        return true
      })

      // Siempre 200 para un webhook válido (aunque sea duplicado): si no, la pasarela lo reintenta.
      return { received: true, duplicate: !isNew }
    },
  )
}
