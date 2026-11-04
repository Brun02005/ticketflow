import { enqueueOutbox, withTransaction, type Pool, type Queryable } from '@ticketflow/common'
import { PaymentEvents, applyChargeResult, setPaymentStatus } from './payments'
import { PspError, type PspClient } from './psp-client'

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

/**
 * Conciliación: los webhooks se pueden perder. Cada cobro que lleva más de
 * `afterSeconds` en "processing" se consulta activamente a la pasarela.
 */
export async function reconcileCharges(pool: Pool, psp: PspClient, afterSeconds: number, logger: Logger) {
  const { rows } = await pool.query<{ id: string; amount: number; currency: string }>(
    `SELECT c.id, p.amount_cents AS amount, p.currency
       FROM charges c JOIN payments p ON p.id = c.payment_id
      WHERE c.status = 'processing' AND c.created_at <= now() - make_interval(secs => $1)
      ORDER BY c.created_at
      LIMIT 20`,
    [afterSeconds],
  )

  let resolved = 0
  for (const charge of rows) {
    let found
    try {
      ;[found] = await psp.findCharges(charge.id)
    } catch (err) {
      logger.warn({ chargeId: charge.id, err: (err as Error).message }, 'no se pudo consultar la pasarela')
      continue
    }
    if (found?.status === 'processing') continue

    await withTransaction(pool, (tx) =>
      applyChargeResult(
        tx,
        found
          ? {
              reference: charge.id,
              pspChargeId: found.id,
              status: found.status as 'succeeded' | 'failed',
              amount: found.amount,
              currency: found.currency,
              failureReason: found.failureReason,
            }
          : // La pasarela no tiene registro: el pedido nunca llegó. Se da por fallido.
            { reference: charge.id, pspChargeId: '', status: 'failed', ...charge, failureReason: 'not_found_at_psp' },
        logger,
      ),
    )
    logger.info({ chargeId: charge.id, status: found?.status ?? 'not_found' }, 'cobro conciliado')
    resolved++
  }
  return resolved
}

/**
 * Envía a la pasarela los reembolsos pendientes. Patrón "reclamar y después llamar":
 * se marca el pago con refund_requested_at (commit) y recién ahí se hace la
 * llamada HTTP. Si falla, se reintenta pasado `retryAfterSeconds`. Es seguro
 * reintentar porque la Idempotency-Key es fija por pago.
 */
export async function dispatchRefunds(
  pool: Pool,
  psp: PspClient,
  webhookUrl: string,
  retryAfterSeconds: number,
  logger: Logger,
) {
  const { rows } = await pool.query<{ id: string; pspChargeId: string }>(
    `UPDATE payments SET refund_requested_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM payments
                    WHERE status = 'refund_pending'
                      AND (refund_requested_at IS NULL
                           OR refund_requested_at <= now() - make_interval(secs => $1))
                    ORDER BY refund_requested_at NULLS FIRST
                    LIMIT 20
                    FOR UPDATE SKIP LOCKED)
      RETURNING id, psp_charge_id AS "pspChargeId"`,
    [retryAfterSeconds],
  )

  for (const payment of rows) {
    try {
      await psp.createRefund(`refund-${payment.id}`, { charge: payment.pspChargeId, webhookUrl })
      logger.info({ paymentId: payment.id }, 'reembolso solicitado a la pasarela')
    } catch (err) {
      if (err instanceof PspError && err.code === 'CHARGE_ALREADY_REFUNDED') continue
      logger.error({ paymentId: payment.id, err: (err as Error).message }, 'falló el pedido de reembolso, se reintentará')
    }
  }
  return rows.length
}

/** La pasarela confirmó el reembolso (webhook refund.succeeded). */
export async function applyRefundSucceeded(db: Queryable, chargeReference: string, logger: Logger) {
  const { rows } = await db.query<{
    id: string
    orderId: string
    userId: string
    eventId: string
    status: string
    amountCents: number
    currency: string
  }>(
    `SELECT p.id, p.order_id AS "orderId", p.user_id AS "userId", p.event_id AS "eventId", p.status,
            p.amount_cents AS "amountCents", p.currency
       FROM payments p JOIN charges c ON c.payment_id = p.id
      WHERE c.id::text = $1
      FOR UPDATE OF p`,
    [chargeReference],
  )
  const payment = rows[0]
  if (!payment || payment.status !== 'refund_pending') {
    if (!payment) logger.warn({ chargeReference }, 'reembolso de un cobro desconocido')
    return
  }
  await setPaymentStatus(db, payment.id, 'refunded')
  await enqueueOutbox(db, {
    type: PaymentEvents.refunded,
    aggregateId: payment.orderId,
    payload: {
      paymentId: payment.id,
      orderId: payment.orderId,
      userId: payment.userId,
      eventId: payment.eventId,
      amountCents: payment.amountCents,
      currency: payment.currency,
    },
  })
}
