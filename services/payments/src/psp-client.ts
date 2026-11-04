/**
 * Cliente HTTP de la pasarela de pagos.
 *
 * Reintenta errores de red y 5xx con backoff exponencial. Es seguro hacerlo
 * porque cada pedido lleva una Idempotency-Key: si el primer intento sí llegó
 * a la pasarela y lo que se perdió fue la respuesta, el reintento devuelve el
 * mismo cobro en vez de crear otro.
 */

export interface PspCharge {
  id: string
  amount: number
  currency: string
  reference: string
  status: 'processing' | 'succeeded' | 'failed'
  failureReason: string | null
}

export class PspError extends Error {
  constructor(
    message: string,
    /** null = no hubo respuesta (timeout o red): el resultado es desconocido. */
    readonly status: number | null,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PspError'
  }

  /** Un 4xx es definitivo: reintentar no va a cambiar la respuesta. */
  get isDefinitive() {
    return this.status !== null && this.status >= 400 && this.status < 500
  }
}

export interface PspClientOptions {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
  retries?: number
}

export class PspClient {
  constructor(private readonly options: PspClientOptions) {}

  createCharge(
    idempotencyKey: string,
    body: { amount: number; currency: string; reference: string; cardNumber: string; webhookUrl: string },
  ) {
    return this.request<PspCharge>('POST', '/v1/charges', body, idempotencyKey)
  }

  createRefund(idempotencyKey: string, body: { charge: string; webhookUrl: string }) {
    return this.request<{ id: string; status: string }>('POST', '/v1/refunds', body, idempotencyKey)
  }

  async findCharges(reference: string): Promise<PspCharge[]> {
    const res = await this.request<{ data: PspCharge[] }>('GET', `/v1/charges?reference=${encodeURIComponent(reference)}`)
    return res.data
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const { retries = 3, timeoutMs = 5000 } = this.options
    let lastError: PspError | undefined

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)))
      try {
        const res = await fetch(`${this.options.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        })
        const payload = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
        if (res.ok) return payload as T
        lastError = new PspError(payload.error?.message ?? `HTTP ${res.status}`, res.status, payload.error?.code)
        if (lastError.isDefinitive) throw lastError
      } catch (err) {
        if (err instanceof PspError && err.isDefinitive) throw err
        lastError = err instanceof PspError ? err : new PspError((err as Error).message, null)
      }
    }
    throw lastError!
  }
}
