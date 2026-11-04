import { createHash } from 'node:crypto'
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  enqueueOutbox,
  withTransaction,
  type AuthContext,
  type Pool,
} from '@ticketflow/common'
import { OrderEvents } from './projection'
import {
  eventRepository,
  idempotencyRepository,
  orderRepository,
  releaseSeatsOf,
  seatRepository,
  type Order,
  type SeatRef,
} from './repository'

export interface CreateOrderInput {
  eventId: string
  seats: SeatRef[]
}

export interface CreateOrderResult {
  /** Solo se guardan respuestas exitosas: un error deja la clave libre para reintentar. */
  statusCode: 201
  body: Order
  /** true si es la respuesta guardada de una request anterior con la misma Idempotency-Key. */
  replayed: boolean
}

const seatLabel = (s: SeatRef) => `${s.sectionId}:${s.row}-${s.number}`

/** Huella del pedido: misma clave con otro body es un error del cliente, no un reintento. */
function hashRequest(input: CreateOrderInput) {
  const seats = input.seats.map(seatLabel).sort()
  return createHash('sha256').update(JSON.stringify({ eventId: input.eventId, seats })).digest('hex')
}

const canSee = (auth: AuthContext, order: Order) => auth.role === 'admin' || auth.userId === order.userId

export class OrdersService {
  constructor(
    private readonly pool: Pool,
    private readonly options: { holdSeconds: number; maxSeatsPerOrder: number },
  ) {}

  /**
   * Reserva asientos y crea la orden pendiente de pago. Todo ocurre en una
   * transacción: o se reservan todos los asientos pedidos, o ninguno.
   */
  async create(auth: AuthContext, input: CreateOrderInput, idempotencyKey: string): Promise<CreateOrderResult> {
    this.validateSeats(input.seats)
    const requestHash = hashRequest(input)

    return withTransaction(this.pool, async (tx) => {
      // 1. Idempotencia: si esta clave ya se usó, devolvemos la misma respuesta.
      if (!(await idempotencyRepository.claim(tx, auth.userId, idempotencyKey, requestHash))) {
        const previous = await idempotencyRepository.find(tx, auth.userId, idempotencyKey)
        if (!previous) throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Reintentá la request')
        if (previous.requestHash !== requestHash) {
          throw new AppError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'Esa Idempotency-Key ya se usó con otro pedido; generá una nueva',
          )
        }
        return { statusCode: 201, body: previous.response as Order, replayed: true }
      }

      // 2. El evento tiene que estar a la venta.
      const event = await eventRepository.find(tx, input.eventId)
      if (!event) throw new NotFoundError('EVENT_NOT_FOUND', 'Evento no encontrado')
      if (event.status !== 'published' || !event.startsAt || event.startsAt.getTime() <= Date.now()) {
        throw new ConflictError('EVENT_NOT_ON_SALE', 'El evento no tiene entradas a la venta')
      }

      // 3. Bloqueo de los asientos y chequeo de disponibilidad.
      const seats = await seatRepository.lockForPurchase(tx, input.eventId, input.seats)
      if (seats.length !== input.seats.length) {
        const found = new Set(seats.map(seatLabel))
        throw new BadRequestError('SEAT_NOT_FOUND', 'Alguno de los asientos no existe', {
          seats: input.seats.filter((s) => !found.has(seatLabel(s))),
        })
      }
      const taken = seats.filter((s) => !s.takeable)
      if (taken.length > 0) {
        throw new ConflictError('SEATS_UNAVAILABLE', 'Alguno de los asientos ya no está disponible', {
          seats: taken.map(({ sectionId, row, number }) => ({ sectionId, row, number })),
        })
      }

      // 4. Orden + retención de los asientos + evento de dominio, en el mismo commit.
      const totalCents = seats.reduce((sum, s) => sum + s.priceCents, 0)
      const { id, expiresAt } = await orderRepository.insert(tx, {
        userId: auth.userId,
        eventId: input.eventId,
        totalCents,
        currency: event.currency ?? 'ARS',
        holdSeconds: this.options.holdSeconds,
      })
      await seatRepository.hold(tx, seats.map((s) => s.id), id, expiresAt)
      await orderRepository.insertItems(tx, id, seats)
      const order = (await orderRepository.findById(tx, id))!

      await enqueueOutbox(tx, { type: OrderEvents.created, aggregateId: id, payload: order })
      await idempotencyRepository.saveResponse(tx, auth.userId, idempotencyKey, 201, order)
      return { statusCode: 201, body: order, replayed: false }
    })
  }

  async get(auth: AuthContext, id: string): Promise<Order> {
    const order = await orderRepository.findById(this.pool, id)
    // Una orden ajena responde 404, no 403: no revelamos que existe.
    if (!order || !canSee(auth, order)) throw orderNotFound()
    return order
  }

  listMine(auth: AuthContext) {
    return orderRepository.listByUser(this.pool, auth.userId)
  }

  async cancel(auth: AuthContext, id: string): Promise<Order> {
    return withTransaction(this.pool, async (tx) => {
      const order = await orderRepository.findById(tx, id, { forUpdate: true })
      if (!order || !canSee(auth, order)) throw orderNotFound()
      if (order.status !== 'pending_payment') {
        throw new ConflictError('ORDER_NOT_CANCELLABLE', `Una orden "${order.status}" no se puede cancelar`)
      }
      await orderRepository.setStatus(tx, id, 'cancelled')
      await releaseSeatsOf(tx, [id])
      await enqueueOutbox(tx, {
        type: OrderEvents.cancelled,
        aggregateId: id,
        payload: { orderId: id, eventId: order.eventId, reason: 'user' },
      })
      return { ...order, status: 'cancelled' as const }
    })
  }

  async availability(eventId: string) {
    const event = await eventRepository.find(this.pool, eventId)
    if (!event) throw new NotFoundError('EVENT_NOT_FOUND', 'Evento no encontrado')
    return { eventId, status: event.status, sections: await seatRepository.availability(this.pool, eventId) }
  }

  async seatMap(eventId: string, sectionId: string) {
    const seats = await seatRepository.seatMap(this.pool, eventId, sectionId)
    if (seats.length === 0) throw new NotFoundError('SECTION_NOT_FOUND', 'Sector no encontrado')
    const rows = new Map<number, { number: number; available: boolean }[]>()
    for (const { row, number, available } of seats) {
      if (!rows.has(row)) rows.set(row, [])
      rows.get(row)!.push({ number, available })
    }
    return { eventId, sectionId, rows: [...rows].map(([row, seats]) => ({ row, seats })) }
  }

  private validateSeats(seats: SeatRef[]) {
    if (seats.length > this.options.maxSeatsPerOrder) {
      throw new BadRequestError(
        'TOO_MANY_SEATS',
        `Se pueden comprar como máximo ${this.options.maxSeatsPerOrder} asientos por orden`,
      )
    }
    if (new Set(seats.map(seatLabel)).size !== seats.length) {
      throw new BadRequestError('DUPLICATE_SEATS', 'Hay asientos repetidos en el pedido')
    }
  }
}

const orderNotFound = () => new NotFoundError('ORDER_NOT_FOUND', 'Orden no encontrada')
