import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Firma de webhooks al estilo Stripe:  header  "t=<unix>,v1=<hex>"
 * donde v1 = HMAC-SHA256(secret, "<t>.<body crudo>").
 *
 * - Incluir el timestamp en lo firmado impide reutilizar un webhook viejo
 *   capturado (replay attack): el receptor rechaza firmas fuera de tolerancia.
 * - Se firma el body crudo, byte a byte: re-serializar el JSON podría cambiar
 *   espacios u orden de claves y romper la verificación.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'psp-signature'

export function signWebhook(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: 'MISSING_SIGNATURE' | 'INVALID_SIGNATURE' | 'STALE_SIGNATURE' }

export function verifyWebhookSignature(
  secret: string,
  header: string | undefined,
  rawBody: string,
  toleranceSeconds = 300,
): WebhookVerification {
  if (!header) return { ok: false, reason: 'MISSING_SIGNATURE' }
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]))
  const timestamp = Number(parts.t)
  if (!Number.isInteger(timestamp) || !parts.v1) return { ok: false, reason: 'INVALID_SIGNATURE' }

  const expected = Buffer.from(signWebhook(secret, rawBody, timestamp).split('v1=')[1]!, 'hex')
  const received = Buffer.from(parts.v1, 'hex')
  // Comparación en tiempo constante: no filtra cuántos caracteres coinciden.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'INVALID_SIGNATURE' }
  }
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'STALE_SIGNATURE' }
  }
  return { ok: true }
}
