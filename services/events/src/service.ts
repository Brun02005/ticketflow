import {
  type AuthContext,
  BadRequestError,
  ConflictError,
  enqueueOutbox,
  ForbiddenError,
  NotFoundError,
  type Pool,
  withTransaction,
} from '@ticketflow/common'
import type { EventCache } from './cache'
import { eventRepository } from './repository'
import type { CreateEventInput, EventDto, ListEventsQuery, UpdateEventInput } from './schemas'

/** Tipos de eventos de dominio que publica este servicio (routing keys en RabbitMQ). */
export const DomainEvents = {
  published: 'event.published',
  cancelled: 'event.cancelled',
} as const

const canManage = (auth: AuthContext | null, event: EventDto) =>
  !!auth && (auth.role === 'admin' || auth.userId === event.organizerId)

function parseFutureDate(value: string): Date {
  const date = new Date(value)
  if (date.getTime() <= Date.now()) {
    throw new BadRequestError('START_IN_PAST', 'La fecha del evento tiene que ser futura')
  }
  return date
}

function encodeCursor(startsAt: string, id: string) {
  return Buffer.from(JSON.stringify([startsAt, id])).toString('base64url')
}

function decodeCursor(cursor: string): { startsAt: Date; id: string } {
  try {
    const [startsAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string]
    const date = new Date(startsAt)
    if (Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error()
    return { startsAt: date, id }
  } catch {
    throw new BadRequestError('INVALID_CURSOR', 'Cursor de paginación inválido')
  }
}

export class EventsService {
  constructor(
    private readonly pool: Pool,
    private readonly cache: EventCache,
  ) {}

  async create(auth: AuthContext, input: CreateEventInput): Promise<EventDto> {
    return withTransaction(this.pool, (tx) =>
      eventRepository.insert(tx, {
        organizerId: auth.userId,
        title: input.title,
        description: input.description ?? '',
        venueName: input.venueName,
        city: input.city,
        startsAt: parseFutureDate(input.startsAt),
        currency: input.currency ?? 'ARS',
        sections: input.sections,
      }),
    )
  }

  /** Detalle de un evento. Los borradores solo los ve su organizador (para el resto, 404). */
  async get(id: string, auth: AuthContext | null): Promise<{ event: EventDto; cacheHit: boolean }> {
    const cached = await this.cache.get(id)
    if (cached) return { event: cached, cacheHit: true }

    const event = await eventRepository.findById(this.pool, id)
    if (!event || (event.status === 'draft' && !canManage(auth, event))) throw notFound()

    // Solo se cachean eventos públicos: un borrador cacheado podría filtrarse a otros usuarios.
    if (event.status !== 'draft') await this.cache.set(event)
    return { event, cacheHit: false }
  }

  async update(id: string, auth: AuthContext, input: UpdateEventInput): Promise<EventDto> {
    const current = await this.loadManageable(id, auth)
    if (current.status !== 'draft') {
      throw new ConflictError('EVENT_NOT_EDITABLE', 'Solo se pueden editar eventos en borrador')
    }
    if (current.version !== input.version) throw versionConflict()

    const { version, sections, startsAt, ...rest } = input
    const updated = await withTransaction(this.pool, (tx) =>
      eventRepository.updateDraft(
        tx,
        id,
        version,
        { ...rest, startsAt: startsAt ? parseFutureDate(startsAt) : undefined },
        sections,
      ),
    )
    // Alguien modificó el evento entre nuestra lectura y el UPDATE.
    if (!updated) throw versionConflict()
    return updated
  }

  async publish(id: string, auth: AuthContext): Promise<EventDto> {
    const current = await this.loadManageable(id, auth)
    if (current.status !== 'draft') throw invalidTransition(current.status, 'published')
    parseFutureDate(current.startsAt)

    const published = await withTransaction(this.pool, async (tx) => {
      const event = await eventRepository.transition(tx, id, ['draft'], 'published')
      if (!event) return null
      // Mismo commit que el cambio de estado: o pasan las dos cosas o ninguna.
      await enqueueOutbox(tx, { type: DomainEvents.published, aggregateId: id, payload: event })
      return event
    })
    if (!published) throw invalidTransition('draft', 'published')

    await this.cache.invalidate(id)
    return published
  }

  async cancel(id: string, auth: AuthContext): Promise<EventDto> {
    const current = await this.loadManageable(id, auth)
    if (current.status === 'cancelled') throw invalidTransition(current.status, 'cancelled')

    const cancelled = await withTransaction(this.pool, async (tx) => {
      const event = await eventRepository.transition(tx, id, [current.status], 'cancelled')
      if (!event) return null
      // Un borrador nunca fue visible: no hay nada que avisar a otros servicios.
      if (current.status === 'published') {
        await enqueueOutbox(tx, {
          type: DomainEvents.cancelled,
          aggregateId: id,
          payload: { eventId: id, cancelledAt: event.cancelledAt },
        })
      }
      return event
    })
    if (!cancelled) throw invalidTransition(current.status, 'cancelled')

    await this.cache.invalidate(id)
    return cancelled
  }

  async list(query: ListEventsQuery) {
    const items = await eventRepository.listPublished(this.pool, {
      from: query.from ? new Date(query.from) : new Date(),
      to: query.to ? new Date(query.to) : undefined,
      city: query.city,
      q: query.q,
      after: query.cursor ? decodeCursor(query.cursor) : undefined,
      // Pedimos uno de más para saber si hay página siguiente sin hacer un COUNT.
      limit: query.limit + 1,
    })
    const hasMore = items.length > query.limit
    const page = hasMore ? items.slice(0, query.limit) : items
    const last = page.at(-1)
    return { items: page, nextCursor: hasMore && last ? encodeCursor(last.startsAt, last.id) : null }
  }

  async listMine(auth: AuthContext) {
    return { items: await eventRepository.listByOrganizer(this.pool, auth.userId) }
  }

  private async loadManageable(id: string, auth: AuthContext): Promise<EventDto> {
    const event = await eventRepository.findById(this.pool, id)
    if (!event || (event.status === 'draft' && !canManage(auth, event))) throw notFound()
    if (!canManage(auth, event)) {
      throw new ForbiddenError('NOT_EVENT_OWNER', 'Solo el organizador del evento puede modificarlo')
    }
    return event
  }
}

const notFound = () => new NotFoundError('EVENT_NOT_FOUND', 'Evento no encontrado')

const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'El evento fue modificado por otra request; volvé a leerlo')

const invalidTransition = (from: string, to: string) =>
  new ConflictError('INVALID_STATUS_TRANSITION', `No se puede pasar de "${from}" a "${to}"`)
