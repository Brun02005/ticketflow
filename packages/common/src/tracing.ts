import { type Context, context, propagation, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

/**
 * Trazas distribuidas a través de la mensajería.
 *
 * El outbox corta la traza: el relay publica más tarde, en otro "hilo" lógico,
 * sin el contexto de la request que generó el evento. Para no perder el hilo,
 * al encolar en el outbox guardamos el traceparent (W3C Trace Context) junto
 * al mensaje; el relay lo usa como padre al publicar y lo manda en los headers
 * AMQP; el consumidor lo extrae y continúa la misma traza.
 *
 * Si OpenTelemetry no está activo (tests, desarrollo) todo esto es un no-op.
 */

export const tracer = trace.getTracer('ticketflow')

export type TraceCarrier = Record<string, string>

/** traceparent/tracestate del contexto activo, para guardarlo junto al mensaje. */
export function captureTraceContext(): TraceCarrier {
  const carrier: TraceCarrier = {}
  propagation.inject(context.active(), carrier)
  return carrier
}

/** Reconstruye el contexto a partir de headers (outbox o AMQP). */
export function extractTraceContext(headers: Record<string, unknown> | undefined): Context {
  const carrier: TraceCarrier = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') carrier[key] = value
    else if (Buffer.isBuffer(value)) carrier[key] = value.toString()
  }
  return propagation.extract(context.active(), carrier)
}

/** Ejecuta `fn` dentro de un span hijo de `parent`, registrando errores. */
export async function withSpan<T>(
  name: string,
  options: { kind: SpanKind; parent?: Context; attributes?: Record<string, string | number> },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { kind: options.kind, attributes: options.attributes },
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span)
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
        throw err
      } finally {
        span.end()
      }
    },
  )
}

export { SpanKind }
