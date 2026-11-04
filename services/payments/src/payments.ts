import {
  ConflictError,
  NotFoundError,
  enqueueOutbox,
  withTransaction,
  type AuthContext,
  type Pool,
  type Queryable,
} from '@ticketflow/common'
import { PspError, type PspClient } from './psp-client'

export type PaymentStatus = 'awaiting_payment' | 'processing' | 'succeeded' | 'refund_pending' | 'refunded' | 'voided'

export interface Payment {
  id: string
  orderId: string
  userId: string
  eventId: string
  amountCents: number
  currency: string
  status: PaymentStatus
  expiresAt: Date
  pspChargeId: string | null
}

export interface Charge {
  id: string
  paymentId: string
  status: 'processing' | 'succeeded' | 'failed'
  cardLast4: string
  failureReason: string | null
  createdAt: Date
}

export const PaymentEvents = {
  succeeded: 'payment.succeeded',
  failed: 'payment.failed',
  refunded: 'payment.refunded',
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PAYMENT_COLUMNS =`p.id, p.order_id AS "orderId", p.user_id AS "userId", p.event_id AS "eventId",
  p.amount_cents AS "amountCents", p.currency, p.status, p.expires_at AS "expiresAt", p.psp_charge_id AS "pspChargeId"`

const CHARGE_COLUMNS = `c.id, c.payment_id AS "paymentId", c.status, c.card_last4 AS "cardLast4",
  c.failure_reason AS "failureReason", c.created_at AS "createdAt"`

export async function findPaymentByOrder(db: Queryable, orderId: string, forUpdate = false) {
  const { rows } = await db.query<Payment>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.order_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [orderId],
  )
  return rows[0] ?? null
}

export async function setPaymentStatus(db: Queryable, id: string, status: PaymentStatus, pspChargeId?: string) {
  await db.query(
    `UPDATE payments SET status = $2, psp_charge_id = COALESCE($3, psp_charge_id), updated_at = now() WHERE id = $1`,
    [id, status, pspChargeId ?? null],
  )
}

/** Resultado de un cobro informado por la pasarela (por webhook o por conciliación). */
export interface ChargeResult {
  /** Nuestra referencia = id del intento de cobro. */
  reference: string
  pspChargeId: string
  status: 'succeeded' | 'failed'
  amount: number
  currency: string
  failureReason: string | null
}

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

/**
 * Aplica el resultado de un cobro. Es la máquina de estados del pago y es
 * idempotente: si el cobro ya no está "processing", no hace nada. Así da igual
 * cuántas veces llegue el webhook o si la conciliación llega primero.
 */
export async function applyChargeResult(db: Queryable, result: ChargeResult, logger: Logger): Promise<void> {
  const unknown = () => logger.warn({ reference: result.reference }, 'resultado de un cobro desconocido, se ignora')
  if (!UUID.test(result.reference)) return unknown()

  const { rows: refs } = await db.query<{ paymentId: string }>(
    `SELECT payment_id AS "paymentId" FROM charges WHERE id = $1`,
    [result.reference],
  )
  if (!refs[0]) return unknown()

  // Orden de locks fijo, pago y después cobro (el mismo que usa pay()): evita deadlocks.
  const { rows: payments } = await db.query<Payment>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1 FOR UPDATE`,
    [refs[0].paymentId],
  )
  const { rows: charges } = await db.query<Charge>(
    `SELECT ${CHARGE_COLUMNS} FROM charges c WHERE c.id = $1 FOR UPDATE`,
    [result.reference],
  )
  const payment = payments[0]!
  const charge = charges[0]!
  if (charge.status !== 'processing') return // ya aplicado: webhook duplicado o conciliación previa

  // Nunca confiar ciegamente en lo que dice el resultado: el monto tiene que coincidir.
  const mismatch = result.status === 'succeeded' && (result.amount !== payment.amountCents || result.currency !== payment.currency)
  if (mismatch) {
    logger.error({ reference: result.reference, result, expected: payment }, 'el monto cobrado no coincide con la orden')
  }

  if (result.status === 'succeeded') {
    await db.query(`UPDATE charges SET status = 'succeeded', psp_charge_id = $2, updated_at = now() WHERE id = $1`, [
      charge.id,
      result.pspChargeId,
    ])
    if (mismatch || payment.status === 'voided') {
      // Se cobró algo que no corresponde (monto distinto, u orden que ya no existe): se devuelve.
      await setPaymentStatus(db, payment.id, 'refund_pending', result.pspChargeId)
      logger.warn({ paymentId: payment.id, mismatch }, 'cobro que no corresponde, se reembolsa')
      return
    }
    await setPaymentStatus(db, payment.id, 'succeeded', result.pspChargeId)
    await enqueueOutbox(db, {
      type: PaymentEvents.succeeded,
      aggregateId: payment.orderId,
      payload: {
        paymentId: payment.id,
        orderId: payment.orderId,
        userId: payment.userId,
        eventId: payment.eventId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        pspChargeId: result.pspChargeId,
      },
    })
    return
  }

  await db.query(
    `UPDATE charges SET status = 'failed', psp_charge_id = COALESCE($2, psp_charge_id), failure_reason = $3, updated_at = now()
      WHERE id = $1`,
    [charge.id, result.pspChargeId || null, result.failureReason ?? 'unknown'],
  )
  if (payment.status === 'processing') {
    // Si la orden todavía está vigente, el cliente puede reintentar con otra tarjeta.
    const next = payment.expiresAt.getTime() > Date.now() ? 'awaiting_payment' : 'voided'
    await setPaymentStatus(db, payment.id, next)
  }
  await enqueueOutbox(db, {
    type: PaymentEvents.failed,
    aggregateId: payment.orderId,
    payload: {
      paymentId: payment.id,
      orderId: payment.orderId,
      userId: payment.userId,
      eventId: payment.eventId,
      reason: result.failureReason,
    },
  })
}

export class PaymentsService {
  constructor(
    private readonly pool: Pool,
    private readonly psp: PspClient,
    private readonly options: { webhookUrl: string },
    private readonly logger: Logger,
  ) {}

  async get(auth: AuthContext, orderId: string) {
    const payment = await findPaymentByOrder(this.pool, orderId)
    if (!payment || (payment.userId !== auth.userId && auth.role !== 'admin')) throw paymentNotFound()
    const { rows: charges } = await this.pool.query<Charge>(
      `SELECT ${CHARGE_COLUMNS} FROM charges c WHERE c.payment_id = $1 ORDER BY c.created_at`,
      [payment.id],
    )
    return {
      payment: { ...payment, expiresAt: payment.expiresAt.toISOString() },
      charges: charges.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    }
  }

  /**
   * Inicia un cobro. Primero se registra el intento (commit), después se llama a
   * la pasarela: nunca se mantiene una transacción abierta durante una llamada HTTP.
   * Si el proceso muere entre las dos cosas, la conciliación resuelve el intento.
   */
  async pay(auth: AuthContext, orderId: string, cardNumber: string) {
    const { payment, chargeId } = await withTransaction(this.pool, async (tx) => {
      const payment = await findPaymentByOrder(tx, orderId, true)
      if (!payment || payment.userId !== auth.userId) throw paymentNotFound()

      switch (payment.status) {
        case 'succeeded':
        case 'refund_pending':
        case 'refunded':
          throw new ConflictError('ALREADY_PAID', 'La orden ya fue pagada')
        case 'voided':
          throw new ConflictError('ORDER_NOT_PAYABLE', 'La orden venció o fue cancelada')
        case 'processing':
          throw new ConflictError('PAYMENT_IN_PROGRESS', 'Ya hay un pago en curso para esta orden')
      }
      if (payment.expiresAt.getTime() <= Date.now()) {
        throw new ConflictError('ORDER_EXPIRED', 'La reserva venció; volvé a elegir los asientos')
      }

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO charges (payment_id, card_last4) VALUES ($1, $2) RETURNING id`,
        [payment.id, cardNumber.slice(-4)],
      )
      await setPaymentStatus(tx, payment.id, 'processing')
      return { payment, chargeId: rows[0]!.id }
    })

    try {
      const pspCharge = await this.psp.createCharge(chargeId, {
        amount: payment.amountCents,
        currency: payment.currency,
        reference: chargeId,
        cardNumber,
        webhookUrl: this.options.webhookUrl,
      })
      await this.pool.query(`UPDATE charges SET psp_charge_id = $2 WHERE id = $1 AND psp_charge_id IS NULL`, [
        chargeId,
        pspCharge.id,
      ])
    } catch (err) {
      if (!(err instanceof PspError) || !err.isDefinitive) {
        // Sin respuesta: no sabemos si se cobró. Queda "processing" y lo resuelve la conciliación.
        this.logger.warn({ chargeId, err: (err as Error).message }, 'resultado del cobro desconocido, se conciliará')
      } else {
        // La pasarela rechazó el pedido: es un fallo definitivo del intento.
        await withTransaction(this.pool, (tx) =>
          applyChargeResult(
            tx,
            {
              reference: chargeId,
              pspChargeId: '',
              status: 'failed',
              amount: payment.amountCents,
              currency: payment.currency,
              failureReason: err.code ?? 'psp_rejected',
            },
            this.logger,
          ),
        )
      }
    }
    return this.get(auth, orderId)
  }
}

const paymentNotFound = () =>
  new NotFoundError('PAYMENT_NOT_FOUND', 'No hay un pago para esa orden (si la acabás de crear, reintentá en unos segundos)')
