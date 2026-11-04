import { createHash, randomUUID } from 'node:crypto'
import { AppError, ConflictError, NotFoundError, signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@ticketflow/common'

/**
 * Pasarela de pagos simulada. Se comporta como Stripe o Mercado Pago:
 * cobro asincrónico, resultado por webhook firmado, idempotencia por header.
 * Y además falla a propósito, para poder probar cómo reacciona el sistema.
 *
 * El estado vive en memoria: es un simulador, no un servicio nuestro.
 */

type Outcome =
  | { status: 'succeeded'; duplicateWebhook?: boolean; dropWebhook?: boolean }
  | { status: 'failed'; reason: string }

/** Tarjetas de prueba, como las de cualquier pasarela real. */
export const TEST_CARDS: Record<string, { description: string; outcome: Outcome }> = {
  '4242424242424242': { description: 'Aprobada', outcome: { status: 'succeeded' } },
  '4000000000000002': { description: 'Rechazada', outcome: { status: 'failed', reason: 'card_declined' } },
  '4000000000009995': {
    description: 'Fondos insuficientes',
    outcome: { status: 'failed', reason: 'insufficient_funds' },
  },
  '4000000000000077': {
    description: 'Aprobada, pero el webhook llega duplicado',
    outcome: { status: 'succeeded', duplicateWebhook: true },
  },
  '4000000000000101': {
    description: 'Aprobada, pero el webhook nunca llega (hay que conciliar)',
    outcome: { status: 'succeeded', dropWebhook: true },
  },
}

export interface Charge {
  id: string
  object: 'charge'
  amount: number
  currency: string
  /** Identificador del comercio para este cobro (lo usamos para conciliar). */
  reference: string
  status: 'processing' | 'succeeded' | 'failed'
  failureReason: string | null
  cardLast4: string
  refunded: boolean
  createdAt: string
}

export interface Refund {
  id: string
  object: 'refund'
  charge: string
  reference: string
  amount: number
  status: 'pending' | 'succeeded'
  createdAt: string
}

export interface WebhookEvent {
  id: string
  type: 'charge.succeeded' | 'charge.failed' | 'refund.succeeded'
  created: number
  data: Charge | Refund
}

export interface WebhookDelivery {
  eventId: string
  type: WebhookEvent['type']
  attempts: number
  delivered: boolean
}

export interface ProviderOptions {
  webhookSecret: string
  minDelayMs: number
  maxDelayMs: number
  webhookMaxAttempts: number
  webhookRetryBaseMs: number
}

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class PaymentProvider {
  private readonly charges = new Map<string, Charge & { webhookUrl: string }>()
  private readonly refunds = new Map<string, Refund & { webhookUrl: string }>()
  private readonly idempotency = new Map<string, { requestHash: string; resourceId: string }>()
  private readonly timers = new Set<NodeJS.Timeout>()
  readonly deliveries: WebhookDelivery[] = []

  constructor(
    private readonly options: ProviderOptions,
    private readonly logger: Logger,
  ) {}

  createCharge(
    idempotencyKey: string,
    input: { amount: number; currency: string; reference: string; cardNumber: string; webhookUrl: string },
  ): Charge {
    const existing = this.replay(`charge:${idempotencyKey}`, input)
    if (existing) return this.publicCharge(this.charges.get(existing)!)

    const charge = {
      id: `ch_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      object: 'charge' as const,
      amount: input.amount,
      currency: input.currency,
      reference: input.reference,
      status: 'processing' as const,
      failureReason: null,
      // Nunca guardamos el número completo de la tarjeta.
      cardLast4: input.cardNumber.slice(-4),
      refunded: false,
      createdAt: new Date().toISOString(),
      webhookUrl: input.webhookUrl,
    }
    this.charges.set(charge.id, charge)
    this.idempotency.set(`charge:${idempotencyKey}`, { requestHash: hash(input), resourceId: charge.id })

    const outcome: Outcome = TEST_CARDS[input.cardNumber]?.outcome ?? { status: 'failed', reason: 'card_not_supported' }
    this.later(() => this.settleCharge(charge.id, outcome))
    return this.publicCharge(charge)
  }

  createRefund(idempotencyKey: string, input: { charge: string; webhookUrl: string }): Refund {
    const existing = this.replay(`refund:${idempotencyKey}`, input)
    if (existing) return this.publicRefund(this.refunds.get(existing)!)

    const charge = this.charges.get(input.charge)
    if (!charge) throw new NotFoundError('CHARGE_NOT_FOUND', 'Cobro inexistente')
    if (charge.status !== 'succeeded')
      throw new ConflictError('CHARGE_NOT_REFUNDABLE', 'Solo se reembolsan cobros aprobados')
    if (charge.refunded) throw new ConflictError('CHARGE_ALREADY_REFUNDED', 'El cobro ya fue reembolsado')

    const refund = {
      id: `re_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      object: 'refund' as const,
      charge: charge.id,
      reference: charge.reference,
      amount: charge.amount,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      webhookUrl: input.webhookUrl,
    }
    charge.refunded = true
    this.refunds.set(refund.id, refund)
    this.idempotency.set(`refund:${idempotencyKey}`, { requestHash: hash(input), resourceId: refund.id })

    this.later(() => {
      ;(refund as Refund).status = 'succeeded'
      this.emit(refund.webhookUrl, 'refund.succeeded', this.publicRefund(refund))
    })
    return this.publicRefund(refund)
  }

  getCharge(id: string): Charge {
    const charge = this.charges.get(id)
    if (!charge) throw new NotFoundError('CHARGE_NOT_FOUND', 'Cobro inexistente')
    return this.publicCharge(charge)
  }

  findCharges(reference: string): Charge[] {
    return [...this.charges.values()].filter((c) => c.reference === reference).map((c) => this.publicCharge(c))
  }

  listCharges(): Charge[] {
    return [...this.charges.values()].map((c) => this.publicCharge(c)).reverse()
  }

  shutdown() {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  /** Misma clave + mismo body: devuelve el recurso original. Misma clave + otro body: error. */
  private replay(key: string, input: unknown): string | null {
    const previous = this.idempotency.get(key)
    if (!previous) return null
    if (previous.requestHash !== hash(input)) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'La Idempotency-Key ya se usó con otros parámetros')
    }
    return previous.resourceId
  }

  private settleCharge(id: string, outcome: Outcome) {
    const charge = this.charges.get(id)!
    charge.status = outcome.status
    if (outcome.status === 'failed') {
      charge.failureReason = outcome.reason
      return this.emit(charge.webhookUrl, 'charge.failed', this.publicCharge(charge))
    }
    if (outcome.dropWebhook) {
      this.logger.warn({ chargeId: id }, '[simulación] webhook perdido')
      return
    }
    const event = this.emit(charge.webhookUrl, 'charge.succeeded', this.publicCharge(charge))
    if (outcome.duplicateWebhook) {
      this.logger.warn({ chargeId: id }, '[simulación] webhook duplicado')
      this.later(() => this.deliver(charge.webhookUrl, event, 1))
    }
  }

  private emit(url: string, type: WebhookEvent['type'], data: Charge | Refund): WebhookEvent {
    const event: WebhookEvent = { id: `evt_${randomUUID()}`, type, created: Math.floor(Date.now() / 1000), data }
    void this.deliver(url, event, 1)
    return event
  }

  /** Entrega con reintentos y backoff exponencial hasta recibir un 2xx, como una pasarela real. */
  private async deliver(url: string, event: WebhookEvent, attempt: number, record?: WebhookDelivery): Promise<void> {
    // Cada envío (incluido el duplicado simulado) lleva su propio registro a través de sus reintentos.
    if (!record) {
      record = { eventId: event.id, type: event.type, attempts: 0, delivered: false }
      this.deliveries.push(record)
    }
    record.attempts++

    const body = JSON.stringify(event)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(this.options.webhookSecret, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        record.delivered = true
        return
      }
      throw new Error(`status ${res.status}`)
    } catch (err) {
      if (attempt >= this.options.webhookMaxAttempts) {
        this.logger.warn({ eventId: event.id, err: (err as Error).message }, 'webhook abandonado tras varios intentos')
        return
      }
      const delay = this.options.webhookRetryBaseMs * 2 ** (attempt - 1)
      this.logger.info({ eventId: event.id, attempt, delay }, 'webhook falló, se reintenta')
      this.later(() => this.deliver(url, event, attempt + 1, record), delay)
    }
  }

  private later(fn: () => unknown, delay?: number) {
    const { minDelayMs, maxDelayMs } = this.options
    const ms = delay ?? minDelayMs + Math.random() * (maxDelayMs - minDelayMs)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void fn()
    }, ms)
    this.timers.add(timer)
  }

  private publicCharge({ webhookUrl: _, ...charge }: Charge & { webhookUrl: string }): Charge {
    return { ...charge }
  }

  private publicRefund({ webhookUrl: _, ...refund }: Refund & { webhookUrl: string }): Refund {
    return { ...refund }
  }
}
