import { createServer, type Server } from 'node:http'
import client from 'prom-client'
import type { Queryable } from './db'

/**
 * Métricas Prometheus. Un registro por proceso (un servicio por proceso).
 *
 * Tres tipos de métricas:
 * - Técnicas automáticas: event loop lag, memoria, GC (collectDefaultMetrics).
 * - Técnicas propias: latencia HTTP, mensajes procesados, outbox.
 * - De negocio: se calculan con una query a la base en el momento del scrape,
 *   así siempre coinciden con la realidad (no hay contadores que se desincronicen
 *   si el proceso se reinicia).
 */
export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

export function setServiceLabel(service: string) {
  registry.setDefaultLabels({ service })
}

export const httpRequestDuration = new client.Histogram({
  name: 'http_server_request_duration_seconds',
  help: 'Duración de las requests HTTP',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

export const messagesProcessed = new client.Counter({
  name: 'messages_processed_total',
  help: 'Mensajes de RabbitMQ consumidos, por resultado (ok, retry, dead_letter)',
  labelNames: ['queue', 'type', 'outcome'],
  registers: [registry],
})

export const outboxPublished = new client.Counter({
  name: 'outbox_published_total',
  help: 'Mensajes del outbox publicados en RabbitMQ',
  labelNames: ['type'],
  registers: [registry],
})

export const outboxPublishFailures = new client.Counter({
  name: 'outbox_publish_failures_total',
  help: 'Intentos fallidos de publicar mensajes del outbox',
  registers: [registry],
})

/**
 * Gauge cuyo valor sale de una query en el momento del scrape.
 * La query devuelve filas { label?: string, value: number }.
 */
export function registerDbGauge(options: {
  name: string
  help: string
  db: Queryable
  query: string
  /** Nombre de la etiqueta que toma el valor de la columna "label" (ej.: "status"). */
  label?: string
}) {
  // Si ya existía (tests que construyen la app varias veces), se reemplaza.
  registry.removeSingleMetric(options.name)
  new client.Gauge({
    name: options.name,
    help: options.help,
    labelNames: options.label ? [options.label] : [],
    registers: [registry],
    async collect() {
      try {
        const { rows } = await options.db.query<{ label?: string; value: number }>(options.query)
        this.reset()
        for (const row of rows) {
          if (options.label) this.set({ [options.label]: row.label ?? 'unknown' }, Number(row.value))
          else this.set(Number(row.value))
        }
      } catch {
        // Si la base no responde, el scrape no falla: la métrica queda sin valor.
      }
    },
  })
}

/** Gauge estándar de mensajes pendientes en el outbox (un número alto = RabbitMQ caído o lento). */
export function registerOutboxGauge(db: Queryable) {
  registerDbGauge({
    name: 'outbox_pending_messages',
    help: 'Mensajes del outbox todavía no publicados',
    db,
    query: `SELECT count(*)::int AS value FROM outbox WHERE published_at IS NULL`,
  })
}

/**
 * Las métricas se sirven en un puerto aparte (no en el de la API): Prometheus
 * las lee desde la red interna y no quedan expuestas a través del gateway.
 */
export function startMetricsServer(port: number): Server {
  const server = createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': registry.contentType })
    res.end(await registry.metrics())
  })
  server.listen(port, '0.0.0.0')
  return server
}
