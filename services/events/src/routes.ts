import {
  optionalAuth,
  requireAuth,
  requireRole,
  type FastifyPluginAsyncTypebox,
  type TokenVerifier,
} from '@ticketflow/common'
import {
  CreateEventBody,
  EventIdParams,
  EventListSchema,
  EventSchema,
  ListEventsQuery,
  OrganizerEventListSchema,
  UpdateEventBody,
} from './schemas'
import type { EventsService } from './service'

const ErrorRef = { $ref: 'ErrorResponse#' }
const bearer = [{ bearerAuth: [] }]

export interface EventsRoutesOptions {
  service: EventsService
  verifyToken: TokenVerifier
}

export const eventsRoutes: FastifyPluginAsyncTypebox<EventsRoutesOptions> = async (app, opts) => {
  const { service } = opts
  const authenticated = requireAuth(opts.verifyToken)
  const organizerOnly = [authenticated, requireRole('organizer', 'admin')]

  app.get(
    '/events',
    {
      schema: {
        tags: ['eventos'],
        summary: 'Listar eventos publicados (paginación por cursor)',
        querystring: ListEventsQuery,
        response: { 200: EventListSchema, 400: ErrorRef },
      },
    },
    async (req) => service.list(req.query),
  )

  app.get(
    '/events/:id',
    {
      onRequest: optionalAuth(opts.verifyToken),
      schema: {
        tags: ['eventos'],
        summary: 'Detalle de un evento',
        description: 'Los borradores solo los ve su organizador. El header x-cache indica HIT o MISS.',
        params: EventIdParams,
        response: { 200: EventSchema, 404: ErrorRef },
      },
    },
    async (req, reply) => {
      const { event, cacheHit } = await service.get(req.params.id, req.auth)
      reply.header('x-cache', cacheHit ? 'HIT' : 'MISS')
      return event
    },
  )

  app.post(
    '/events',
    {
      onRequest: organizerOnly,
      schema: {
        tags: ['eventos'],
        summary: 'Crear un evento en borrador',
        security: bearer,
        body: CreateEventBody,
        response: { 201: EventSchema, 400: ErrorRef, 401: ErrorRef, 403: ErrorRef },
      },
    },
    async (req, reply) => reply.status(201).send(await service.create(req.auth!, req.body)),
  )

  app.patch(
    '/events/:id',
    {
      onRequest: authenticated,
      schema: {
        tags: ['eventos'],
        summary: 'Editar un borrador (bloqueo optimista con `version`)',
        security: bearer,
        params: EventIdParams,
        body: UpdateEventBody,
        response: { 200: EventSchema, 400: ErrorRef, 403: ErrorRef, 404: ErrorRef, 409: ErrorRef },
      },
    },
    async (req) => service.update(req.params.id, req.auth!, req.body),
  )

  app.post(
    '/events/:id/publish',
    {
      onRequest: authenticated,
      schema: {
        tags: ['eventos'],
        summary: 'Publicar un borrador (emite event.published)',
        security: bearer,
        params: EventIdParams,
        response: { 200: EventSchema, 403: ErrorRef, 404: ErrorRef, 409: ErrorRef },
      },
    },
    async (req) => service.publish(req.params.id, req.auth!),
  )

  app.post(
    '/events/:id/cancel',
    {
      onRequest: authenticated,
      schema: {
        tags: ['eventos'],
        summary: 'Cancelar un evento (emite event.cancelled si estaba publicado)',
        security: bearer,
        params: EventIdParams,
        response: { 200: EventSchema, 403: ErrorRef, 404: ErrorRef, 409: ErrorRef },
      },
    },
    async (req) => service.cancel(req.params.id, req.auth!),
  )

  app.get(
    '/organizer/events',
    {
      onRequest: organizerOnly,
      schema: {
        tags: ['organizador'],
        summary: 'Mis eventos (todos los estados)',
        security: bearer,
        response: { 200: OrganizerEventListSchema, 401: ErrorRef, 403: ErrorRef },
      },
    },
    async (req) => service.listMine(req.auth!),
  )
}
