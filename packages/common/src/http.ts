import { randomUUID } from 'node:crypto'
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { trace } from '@opentelemetry/api'
import Fastify, { type FastifyError } from 'fastify'
import { AppError } from './errors'
import { httpRequestDuration, setServiceLabel, startMetricsServer } from './metrics'

export interface HttpAppOptions {
  serviceName: string
  logLevel?: string
  /** Ver parseTrustProxy. Define de dónde sale req.ip cuando hay un proxy adelante. */
  trustProxy?: boolean | string
  /** Chequeos que corre /health/ready (ej.: ping a la base). Si alguno falla, responde 503. */
  readinessChecks?: Record<string, () => Promise<unknown>>
}

/** Schema de error compartido, para documentar respuestas en OpenAPI. */
export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(Type.Unknown()),
    }),
  },
  { $id: 'ErrorResponse' },
)

/**
 * Crea una app Fastify con lo que todo servicio necesita:
 * logs JSON estructurados, request id propagado entre servicios,
 * formato de error uniforme y endpoints de health para el orquestador.
 */
export function createHttpApp(opts: HttpAppOptions) {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'info',
      base: { service: opts.serviceName },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },
    },
    // Si otro servicio (o el gateway) ya mandó un x-request-id, lo reutilizamos
    // para poder seguir una misma request a través de todos los logs.
    trustProxy: opts.trustProxy ?? false,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.addSchema(ErrorResponse)
  // Identidad del usuario; la completan los hooks de ./auth.
  app.decorateRequest('auth', null)

  setServiceLabel(opts.serviceName)

  app.addHook('onRequest', async (req) => {
    // La instrumentación HTTP nombra el span solo con el método ("GET"); le agregamos
    // la ruta (con parámetros, no la URL concreta) para que en Jaeger se pueda agrupar.
    const route = req.routeOptions.url
    if (route) {
      const span = trace.getActiveSpan()
      span?.updateName(`${req.method} ${route}`)
      span?.setAttribute('http.route', route)
      span?.setAttribute('ticketflow.request_id', req.id)
    }
  })

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'sin_ruta'
    if (route.startsWith('/health')) return
    httpRequestDuration.observe(
      { method: req.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    )
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      })
    }
    if (err.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'La request no cumple el formato esperado',
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      })
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        error: { code: err.code ?? 'REQUEST_ERROR', message: err.message },
      })
    }
    req.log.error({ err }, 'error no controlado')
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' },
    })
  })

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `Ruta ${req.method} ${req.url} no encontrada` },
    }),
  )

  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }))

  app.get('/health/ready', { schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {}
    await Promise.all(
      Object.entries(opts.readinessChecks ?? {}).map(async ([name, check]) => {
        try {
          await check()
          checks[name] = 'ok'
        } catch {
          checks[name] = 'fail'
        }
      }),
    )
    const healthy = Object.values(checks).every((c) => c === 'ok')
    return reply.status(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', checks })
  })

  return app
}

export type HttpApp = ReturnType<typeof createHttpApp>

/**
 * Levanta el servidor y cierra ordenadamente ante SIGINT/SIGTERM:
 * deja de aceptar conexiones, termina las requests en curso y corre los
 * hooks onClose (cerrar pool de DB, conexiones a colas, etc.).
 */
export async function startServer(app: HttpApp, port: number, host = '0.0.0.0') {
  // Métricas en un puerto interno aparte (ver metrics.ts).
  const metricsPort = Number(process.env.METRICS_PORT ?? 9464)
  const metricsServer = startMetricsServer(metricsPort)

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'apagando servidor')
    try {
      await app.close()
      metricsServer.close()
      // Envía los spans que quedaron en memoria antes de salir.
      await globalThis.__otelShutdown?.()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'error durante el apagado')
      process.exit(1)
    }
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await app.listen({ port, host })
  app.log.info({ metricsPort }, 'métricas Prometheus en /metrics')
}
