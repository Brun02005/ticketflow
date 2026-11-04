import { type FastifyPluginAsyncTypebox, requireAuth, type TokenVerifier, Type } from '@ticketflow/common'
import type { OrdersService } from './service'

const ErrorRef = { $ref: 'ErrorResponse#' }
const bearer = [{ bearerAuth: [] }]

const SeatRefSchema = Type.Object({
  sectionId: Type.String({ format: 'uuid' }),
  row: Type.Integer({ minimum: 1 }),
  number: Type.Integer({ minimum: 1 }),
})

const OrderSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  userId: Type.String({ format: 'uuid' }),
  eventId: Type.String({ format: 'uuid' }),
  status: Type.Union([
    Type.Literal('pending_payment'),
    Type.Literal('paid'),
    Type.Literal('expired'),
    Type.Literal('cancelled'),
  ]),
  totalCents: Type.Integer(),
  currency: Type.String(),
  expiresAt: Type.String({ format: 'date-time', description: 'Hasta cuándo se mantienen reservados los asientos' }),
  createdAt: Type.String({ format: 'date-time' }),
  paidAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  items: Type.Array(
    Type.Object({
      sectionId: Type.String(),
      sectionName: Type.String(),
      row: Type.Integer(),
      number: Type.Integer(),
      priceCents: Type.Integer(),
    }),
  ),
})

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })
const EventParams = Type.Object({ eventId: Type.String({ format: 'uuid' }) })

export interface OrdersRoutesOptions {
  service: OrdersService
  verifyToken: TokenVerifier
}

export const ordersRoutes: FastifyPluginAsyncTypebox<OrdersRoutesOptions> = async (app, opts) => {
  const { service } = opts
  const authenticated = requireAuth(opts.verifyToken)

  app.post(
    '/orders',
    {
      onRequest: authenticated,
      schema: {
        tags: ['órdenes'],
        summary: 'Reservar asientos y crear una orden pendiente de pago',
        description:
          'Requiere el header Idempotency-Key: si la request se reintenta con la misma clave, ' +
          'se devuelve la misma orden en lugar de crear otra (header idempotent-replayed: true).',
        security: bearer,
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8, maxLength: 100, description: 'Ej.: un UUID v4' }),
        }),
        body: Type.Object({
          eventId: Type.String({ format: 'uuid' }),
          seats: Type.Array(SeatRefSchema, { minItems: 1, maxItems: 50 }),
        }),
        response: { 201: OrderSchema, 400: ErrorRef, 401: ErrorRef, 404: ErrorRef, 409: ErrorRef, 422: ErrorRef },
      },
    },
    async (req, reply) => {
      const result = await service.create(req.auth!, req.body, req.headers['idempotency-key'])
      if (result.replayed) reply.header('idempotent-replayed', 'true')
      return reply.status(result.statusCode).send(result.body)
    },
  )

  app.get(
    '/orders',
    {
      onRequest: authenticated,
      schema: {
        tags: ['órdenes'],
        summary: 'Mis órdenes',
        security: bearer,
        response: { 200: Type.Object({ items: Type.Array(OrderSchema) }), 401: ErrorRef },
      },
    },
    async (req) => ({ items: await service.listMine(req.auth!) }),
  )

  app.get(
    '/orders/:id',
    {
      onRequest: authenticated,
      schema: {
        tags: ['órdenes'],
        summary: 'Detalle de una orden',
        security: bearer,
        params: IdParams,
        response: { 200: OrderSchema, 401: ErrorRef, 404: ErrorRef },
      },
    },
    async (req) => service.get(req.auth!, req.params.id),
  )

  app.post(
    '/orders/:id/cancel',
    {
      onRequest: authenticated,
      schema: {
        tags: ['órdenes'],
        summary: 'Cancelar una orden pendiente y liberar los asientos',
        security: bearer,
        params: IdParams,
        response: { 200: OrderSchema, 401: ErrorRef, 404: ErrorRef, 409: ErrorRef },
      },
    },
    async (req) => service.cancel(req.auth!, req.params.id),
  )

  app.get(
    '/availability/:eventId',
    {
      schema: {
        tags: ['disponibilidad'],
        summary: 'Asientos disponibles por sector',
        params: EventParams,
        response: {
          200: Type.Object({
            eventId: Type.String(),
            status: Type.String(),
            sections: Type.Array(
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                priceCents: Type.Integer(),
                total: Type.Integer(),
                available: Type.Integer(),
              }),
            ),
          }),
          404: ErrorRef,
        },
      },
    },
    async (req) => service.availability(req.params.eventId),
  )

  app.get(
    '/availability/:eventId/sections/:sectionId',
    {
      schema: {
        tags: ['disponibilidad'],
        summary: 'Mapa de asientos de un sector',
        params: Type.Object({
          eventId: Type.String({ format: 'uuid' }),
          sectionId: Type.String({ format: 'uuid' }),
        }),
        response: {
          200: Type.Object({
            eventId: Type.String(),
            sectionId: Type.String(),
            rows: Type.Array(
              Type.Object({
                row: Type.Integer(),
                seats: Type.Array(Type.Object({ number: Type.Integer(), available: Type.Boolean() })),
              }),
            ),
          }),
          404: ErrorRef,
        },
      },
    },
    async (req) => service.seatMap(req.params.eventId, req.params.sectionId),
  )
}
