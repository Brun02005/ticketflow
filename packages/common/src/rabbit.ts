import {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  connect,
  type RecoveringChannelModel,
} from 'amqplib'
import { messagesProcessed } from './metrics'
import { extractTraceContext, SpanKind, type TraceCarrier, withSpan } from './tracing'

/** Exchange de tipo topic donde se publican todos los eventos de dominio. */
export const EVENTS_EXCHANGE = 'ticketflow.events'
/** Exchange adonde van los mensajes que no se pudieron procesar (dead letters). */
export const DEAD_LETTER_EXCHANGE = 'ticketflow.dlx'

/** Formato común de todos los mensajes que viajan por RabbitMQ. */
export interface DomainEvent<T = unknown> {
  /** Id único del mensaje: los consumidores lo usan para descartar duplicados. */
  messageId: string
  /** Ej.: "event.published". También es la routing key. */
  type: string
  aggregateId: string
  occurredAt: string
  payload: T
}

export interface MessagePublisher {
  /** `headers`: contexto de la traza (traceparent) que viaja con el mensaje. */
  publish(event: DomainEvent, headers?: TraceCarrier): Promise<void>
}

interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/**
 * Publicador con publisher confirms: `publish` recién resuelve cuando el broker
 * confirma que guardó el mensaje. Se reconecta solo (con backoff) si se cae la
 * conexión; mientras tanto `publish` falla y el outbox reintenta más tarde.
 */
export class RabbitPublisher implements MessagePublisher {
  private channel: ConfirmChannel | null = null

  private constructor(private readonly connection: RecoveringChannelModel) {}

  static async connect(url: string, logger: Logger): Promise<RabbitPublisher> {
    let publisher: RabbitPublisher | undefined
    const connection = await connect(url, {
      recovery: {
        initialDelay: 200,
        maxDelay: 10_000,
        maxRetries: Infinity,
        // No esperamos la primera conexión: el servicio arranca aunque RabbitMQ
        // esté caído, y los eventos se acumulan en el outbox hasta que vuelva.
        waitForConnect: false,
        setup: async (model: ChannelModel) => {
          const channel = await model.createConfirmChannel()
          await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
          if (publisher) publisher.channel = channel
        },
      },
    })
    publisher = new RabbitPublisher(connection)

    connection.on('connect', () => logger.info({}, 'conectado a RabbitMQ'))
    connection.on('disconnect', (err: Error) => {
      publisher!.channel = null
      logger.warn({ err: err?.message }, 'desconectado de RabbitMQ, reintentando')
    })
    connection.on('error', (err: Error) => logger.warn({ err: err.message }, 'error de RabbitMQ'))
    return publisher
  }

  get connected() {
    return this.channel !== null
  }

  async waitForConnect() {
    await this.connection.waitForConnect()
    // `setup` corre después del evento de conexión: esperamos a que haya canal.
    while (!this.channel) await new Promise((r) => setTimeout(r, 10))
  }

  async publish(event: DomainEvent, headers: TraceCarrier = {}): Promise<void> {
    const channel = this.channel
    if (!channel) throw new Error('RabbitMQ no disponible')

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        event.type,
        Buffer.from(JSON.stringify(event)),
        {
          messageId: event.messageId,
          type: event.type,
          contentType: 'application/json',
          persistent: true,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
          headers,
        },
        (err) => (err ? reject(err) : resolve()),
      )
    })
  }

  async close() {
    await this.connection.close().catch(() => {})
  }
}

/**
 * Error que indica que el mensaje nunca va a poder procesarse (formato inválido,
 * contrato roto). No tiene sentido reintentarlo: va directo a la dead-letter queue.
 */
export class PoisonMessageError extends Error {
  override name = 'PoisonMessageError'
}

export interface ConsumerOptions {
  /** Nombre de la cola durable propia del servicio (ej.: "orders.events"). */
  queue: string
  /** Routing keys que le interesan (ej.: ["event.published", "event.cancelled"]). */
  bindings: string[]
  /** Cuántos mensajes se procesan en paralelo como máximo. */
  prefetch?: number
  /** Reintentos ante errores transitorios antes de mandar el mensaje a la DLQ. */
  maxRetries?: number
  /** Espera entre reintentos. */
  retryDelayMs?: number
}

interface ConsumerLogger extends Logger {
  error(obj: object, msg?: string): void
}

const RETRY_HEADER = 'x-retry-count'

/**
 * Consumidor con reintentos diferidos y dead-letter queue. Topología por servicio:
 *
 *   <queue>        cola principal (quorum: replicada y durable)
 *   <queue>.retry  mensajes que fallaron; esperan `retryDelayMs` (TTL) y vuelven a <queue>
 *   <queue>.dlq    mensajes que no se pudieron procesar; quedan para inspección manual
 *
 * - Error transitorio (base caída, timeout): se reenvía a .retry con un contador
 *   en el header. El consumidor no se bloquea esperando y el reintento llega más tarde.
 * - Se superó `maxRetries`, o es un PoisonMessageError o JSON inválido: va a .dlq.
 * - Ack manual recién cuando el handler terminó (o el reenvío fue confirmado por el
 *   broker): si el proceso muere a mitad de camino, el mensaje se vuelve a entregar.
 *   Garantía at-least-once, por eso los handlers son idempotentes (ver ./inbox).
 *
 * Los reintentos los cuenta la aplicación y no `x-delivery-limit`: en RabbitMQ 4
 * un nack con requeue no incrementa el contador de entregas, así que ese límite
 * nunca se alcanzaría y el mensaje quedaría reintentándose en loop.
 */
export class RabbitConsumer {
  private firstSetup: Promise<void>

  private constructor(
    private readonly connection: RecoveringChannelModel,
    firstSetup: Promise<void>,
  ) {
    this.firstSetup = firstSetup
  }

  static async start(
    url: string,
    options: ConsumerOptions,
    handler: (event: DomainEvent) => Promise<void>,
    logger: ConsumerLogger,
  ): Promise<RabbitConsumer> {
    const { queue, bindings, prefetch = 10, maxRetries = 5, retryDelayMs = 2000 } = options
    const retryQueue = `${queue}.retry`
    const deadLetterQueue = `${queue}.dlq`
    let ready!: () => void
    const firstSetup = new Promise<void>((resolve) => (ready = resolve))

    const toDeadLetter = (channel: ConfirmChannel, msg: ConsumeMessage) => channel.nack(msg, false, false)

    const scheduleRetry = async (channel: ConfirmChannel, msg: ConsumeMessage, attempt: number) => {
      await new Promise<void>((resolve, reject) => {
        channel.sendToQueue(
          retryQueue,
          msg.content,
          {
            ...msg.properties,
            headers: { ...msg.properties.headers, [RETRY_HEADER]: attempt },
            expiration: String(retryDelayMs),
            persistent: true,
          },
          (err) => (err ? reject(err) : resolve()),
        )
      })
      // Recién con el reenvío confirmado soltamos el original: nunca se pierde.
      channel.ack(msg)
    }

    const onMessage = async (channel: ConfirmChannel, msg: ConsumeMessage) => {
      let event: DomainEvent
      try {
        event = JSON.parse(msg.content.toString()) as DomainEvent
        if (!event.messageId || !event.type) throw new PoisonMessageError('mensaje sin messageId o type')
      } catch (err) {
        logger.error({ err: (err as Error).message, queue }, 'mensaje ilegible, se envía a la DLQ')
        messagesProcessed.inc({ queue, type: 'unknown', outcome: 'dead_letter' })
        return toDeadLetter(channel, msg)
      }

      try {
        // El procesamiento continúa la traza de quien originó el mensaje (ver tracing.ts).
        await withSpan(
          `process ${event.type}`,
          {
            kind: SpanKind.CONSUMER,
            parent: extractTraceContext(msg.properties.headers),
            attributes: {
              'messaging.system': 'rabbitmq',
              'messaging.destination.name': queue,
              'messaging.message.id': event.messageId,
            },
          },
          () => handler(event),
        )
        channel.ack(msg)
        messagesProcessed.inc({ queue, type: event.type, outcome: 'ok' })
      } catch (err) {
        const retries = Number(msg.properties.headers?.[RETRY_HEADER] ?? 0)
        const context = { err: (err as Error).message, messageId: event.messageId, type: event.type, retries }
        if (err instanceof PoisonMessageError || retries >= maxRetries) {
          logger.error(context, 'mensaje descartado a la DLQ')
          messagesProcessed.inc({ queue, type: event.type, outcome: 'dead_letter' })
          return toDeadLetter(channel, msg)
        }
        logger.warn(context, 'falló el procesamiento, se reintenta más tarde')
        messagesProcessed.inc({ queue, type: event.type, outcome: 'retry' })
        await scheduleRetry(channel, msg, retries + 1).catch((retryErr) => {
          // Si ni siquiera se pudo reenviar, lo devolvemos a la cola tal cual.
          logger.warn({ err: (retryErr as Error).message }, 'no se pudo agendar el reintento')
          channel.nack(msg, false, true)
        })
      }
    }

    const connection = await connect(url, {
      recovery: {
        initialDelay: 200,
        maxDelay: 10_000,
        maxRetries: Infinity,
        waitForConnect: false,
        // Corre en cada (re)conexión: recrea la topología y vuelve a suscribirse.
        setup: async (model: ChannelModel) => {
          const channel = await model.createConfirmChannel()
          await channel.prefetch(prefetch)
          await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
          await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true })
          await channel.assertQueue(deadLetterQueue, { durable: true })
          await channel.bindQueue(deadLetterQueue, DEAD_LETTER_EXCHANGE, queue)
          await channel.assertQueue(retryQueue, {
            durable: true,
            // Al vencer el TTL, el mensaje vuelve a la cola principal por el exchange default.
            arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
          })
          await channel.assertQueue(queue, {
            durable: true,
            arguments: {
              'x-queue-type': 'quorum',
              'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
              'x-dead-letter-routing-key': queue,
            },
          })
          for (const key of bindings) await channel.bindQueue(queue, EVENTS_EXCHANGE, key)
          await channel.consume(queue, (msg) => msg && void onMessage(channel, msg))
          ready()
        },
      },
    })

    connection.on('connect', () => logger.info({ queue }, 'consumidor conectado a RabbitMQ'))
    connection.on('disconnect', (err: Error) =>
      logger.warn({ err: err?.message, queue }, 'consumidor desconectado, reintentando'),
    )
    connection.on('error', (err: Error) => logger.warn({ err: err.message }, 'error de RabbitMQ'))

    return new RabbitConsumer(connection, firstSetup)
  }

  /** Resuelve cuando la topología existe y el consumidor está suscripto. */
  waitUntilReady() {
    return this.firstSetup
  }

  async close() {
    await this.connection.close().catch(() => {})
  }
}
