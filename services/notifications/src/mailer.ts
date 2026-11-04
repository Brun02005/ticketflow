import nodemailer from 'nodemailer'
import type { RenderedEmail } from './templates'

export interface OutgoingEmail extends RenderedEmail {
  to: string
  /**
   * Message-ID determinístico (derivado del id de la notificación). Si un
   * reintento llega a mandar el mismo email dos veces, los clientes de correo
   * lo reconocen como el mismo mensaje.
   */
  messageId: string
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>
  close(): void
}

export function createSmtpMailer(options: {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
}): Mailer {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: options.user ? { user: options.user, pass: options.pass } : undefined,
    connectionTimeout: 5000,
    socketTimeout: 10_000,
  })

  return {
    async send(email) {
      await transport.sendMail({
        from: options.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        messageId: email.messageId,
        attachments: email.attachments,
      })
    },
    close: () => transport.close(),
  }
}
