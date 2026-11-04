import QRCode from 'qrcode'
import type { NotificationKind } from './handlers'
import { signTicket } from './tickets'

export interface EmailAttachment {
  filename: string
  content: Buffer
  contentType: string
  /** Content-ID: permite mostrar la imagen dentro del HTML con <img src="cid:..."> */
  cid: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
  attachments: EmailAttachment[]
}

export interface EventInfo {
  id: string
  title: string
  venueName: string
  city: string
  startsAt: Date
}

export interface RenderInput {
  kind: NotificationKind
  payload: Record<string, unknown>
  event: EventInfo | null
}

export interface RenderOptions {
  timezone: string
  ticketSecret: string
}

/** Faltan datos para armar el email (ej.: todavía no llegó event.published). Se reintenta más tarde. */
export class MissingDataError extends Error {
  override name = 'MissingDataError'
}

const escapeHtml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency }).format(cents / 100)

const FAILURE_REASONS: Record<string, string> = {
  card_declined: 'la tarjeta fue rechazada',
  insufficient_funds: 'la tarjeta no tiene fondos suficientes',
  card_not_supported: 'la tarjeta no es aceptada',
}

function layout(title: string, body: string) {
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden">
    <div style="background:#4f46e5;color:#ffffff;padding:20px 24px;font-size:20px;font-weight:bold">TicketFlow</div>
    <div style="padding:24px">
      <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
      ${body}
    </div>
    <div style="padding:16px 24px;font-size:12px;color:#7b8794;border-top:1px solid #e4e7eb">
      Este es un email automático de un proyecto de portfolio. No respondas a este mensaje.
    </div>
  </div>
</body></html>`
}

export async function renderEmail(input: RenderInput, options: RenderOptions): Promise<RenderedEmail> {
  const { kind, payload } = input
  if (kind === 'welcome') {
    return {
      subject: 'Bienvenido a TicketFlow',
      html: layout('¡Tu cuenta está lista!', '<p>Ya podés comprar entradas para los mejores eventos.</p>'),
      text: '¡Tu cuenta está lista! Ya podés comprar entradas para los mejores eventos.',
      attachments: [],
    }
  }

  const event = input.event
  if (!event) throw new MissingDataError('todavía no se conocen los datos del evento')
  const when = new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: options.timezone,
  }).format(event.startsAt)
  const eventLine = `<p style="margin:0 0 16px"><strong>${escapeHtml(event.title)}</strong><br>${escapeHtml(event.venueName)}, ${escapeHtml(event.city)}<br>${escapeHtml(when)}</p>`
  const eventText = `${event.title} — ${event.venueName}, ${event.city} — ${when}`

  switch (kind) {
    case 'tickets': {
      const items = payload.items as {
        sectionId: string
        sectionName: string
        row: number
        number: number
        priceCents: number
      }[]
      const orderId = payload.orderId as string
      const currency = payload.currency as string
      const tickets = await Promise.all(
        items.map(async (item, i) => {
          const code = signTicket(options.ticketSecret, {
            orderId,
            eventId: event.id,
            sectionId: item.sectionId,
            row: item.row,
            number: item.number,
          })
          const png = await QRCode.toBuffer(code, { type: 'png', width: 220, margin: 1, errorCorrectionLevel: 'M' })
          return {
            item,
            code,
            attachment: {
              filename: `entrada-${i + 1}.png`,
              content: png,
              contentType: 'image/png',
              cid: `ticket-${i + 1}@ticketflow`,
            },
          }
        }),
      )
      const cards = tickets
        .map(
          ({ item, attachment }) => `
      <div style="border:1px solid #e4e7eb;border-radius:8px;padding:16px;margin:0 0 12px;text-align:center">
        <div style="font-weight:bold">${escapeHtml(item.sectionName)} · Fila ${item.row} · Asiento ${item.number}</div>
        <img src="cid:${attachment.cid}" width="220" height="220" alt="Código QR de la entrada" style="margin-top:8px">
      </div>`,
        )
        .join('')
      return {
        subject: `Tus entradas para ${event.title}`,
        html: layout(
          '¡Compra confirmada!',
          `${eventLine}${cards}<p>Total pagado: <strong>${escapeHtml(money(payload.totalCents as number, currency))}</strong></p>
           <p style="font-size:13px;color:#52606d">Mostrá el QR en la entrada. Cada código está firmado digitalmente y es único.</p>`,
        ),
        text: [
          '¡Compra confirmada!',
          eventText,
          ...tickets.map(
            ({ item, code }) => `${item.sectionName} · Fila ${item.row} · Asiento ${item.number}: ${code}`,
          ),
          `Total pagado: ${money(payload.totalCents as number, currency)}`,
        ].join('\n'),
        attachments: tickets.map((t) => t.attachment),
      }
    }
    case 'payment_failed': {
      const reason = FAILURE_REASONS[payload.reason as string] ?? 'hubo un problema con el pago'
      return {
        subject: `No pudimos procesar tu pago para ${event.title}`,
        html: layout(
          'Tu pago no se pudo completar',
          `${eventLine}<p>Motivo: ${escapeHtml(reason)}.</p><p>Tus asientos siguen reservados por unos minutos: podés intentar con otra tarjeta.</p>`,
        ),
        text: `Tu pago no se pudo completar. ${eventText}. Motivo: ${reason}. Podés intentar con otra tarjeta.`,
        attachments: [],
      }
    }
    case 'order_expired':
      return {
        subject: `Tu reserva para ${event.title} venció`,
        html: layout(
          'Tu reserva venció',
          `${eventLine}<p>No recibimos el pago a tiempo y liberamos los asientos. Si todavía querés ir, podés volver a elegirlos.</p>`,
        ),
        text: `Tu reserva venció. ${eventText}. Liberamos los asientos.`,
        attachments: [],
      }
    case 'event_cancelled': {
      const refund = payload.wasPaid ? '<p>Vas a recibir el reembolso completo en el mismo medio de pago.</p>' : ''
      return {
        subject: `Se canceló ${event.title}`,
        html: layout(
          'El evento fue cancelado',
          `${eventLine}<p>Lamentamos informarte que el organizador canceló el evento.</p>${refund}`,
        ),
        text: `El evento fue cancelado: ${eventText}.${payload.wasPaid ? ' Vas a recibir el reembolso completo.' : ''}`,
        attachments: [],
      }
    }
    case 'refund': {
      const amount = money(payload.amountCents as number, payload.currency as string)
      return {
        subject: `Te devolvimos ${amount}`,
        html: layout(
          'Reembolso acreditado',
          `${eventLine}<p>Te reintegramos <strong>${escapeHtml(amount)}</strong> en el mismo medio de pago.</p>`,
        ),
        text: `Reembolso acreditado: ${amount}. ${eventText}.`,
        attachments: [],
      }
    }
  }
}
