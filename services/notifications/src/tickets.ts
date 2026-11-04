import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Código de entrada firmado: lo que va dentro del QR.
 *
 *   TF1.<datos en base64url>.<HMAC-SHA256 en base64url>
 *
 * Se puede validar sin consultar ninguna base (en la puerta del estadio,
 * sin conexión): quien no tenga el secreto no puede fabricar ni modificar
 * una entrada, porque cambiar un solo byte invalida la firma.
 */
export interface TicketData {
  orderId: string
  eventId: string
  sectionId: string
  row: number
  number: number
}

const PREFIX = 'TF1'

const sign = (secret: string, data: string) => createHmac('sha256', secret).update(`${PREFIX}.${data}`).digest('base64url')

export function signTicket(secret: string, ticket: TicketData): string {
  const data = Buffer.from(
    JSON.stringify([ticket.orderId, ticket.eventId, ticket.sectionId, ticket.row, ticket.number]),
  ).toString('base64url')
  return `${PREFIX}.${data}.${sign(secret, data)}`
}

export function verifyTicket(secret: string, code: string): TicketData | null {
  const [prefix, data, signature] = code.split('.')
  if (prefix !== PREFIX || !data || !signature) return null

  const expected = Buffer.from(sign(secret, data))
  const received = Buffer.from(signature)
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null

  try {
    const [orderId, eventId, sectionId, row, number] = JSON.parse(Buffer.from(data, 'base64url').toString()) as [
      string,
      string,
      string,
      number,
      number,
    ]
    return { orderId, eventId, sectionId, row, number }
  } catch {
    return null
  }
}
