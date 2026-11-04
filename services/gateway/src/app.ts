import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import proxy from '@fastify/http-proxy'
import rateLimit from '@fastify/rate-limit'
import { createHttpApp, parseTrustProxy, extractBearerToken, type Redis, type TokenVerifier } from '@ticketflow/common'
import type { GatewayConfig } from './config'

export interface GatewayDeps {
  redis: Redis
  verifyToken: TokenVerifier
}

/** Rutas a las que el gateway no les valida el token: las resuelve auth-service. */
const AUTH_PREFIXES = ['/auth/', '/.well-known/']

async function ping(baseUrl: string) {
  const res = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(1000) })
  if (!res.ok) throw new Error(`status ${res.status}`)
}

/** Traduce los errores de conexión con un servicio al formato de error común. */
function upstreamErrorBody(error: Error & { statusCode?: number }) {
  const timeout = error.statusCode === 504
  return {
    status: timeout ? 504 : 503,
    body: {
      error: {
        code: timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        message: 'El servicio no está disponible en este momento; reintentá en unos segundos',
      },
    },
  }
}

export async function buildApp(config: GatewayConfig, deps: GatewayDeps) {
  const app = createHttpApp({
    serviceName: 'api-gateway',
    logLevel: config.LOG_LEVEL,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    readinessChecks: {
      redis: () => deps.redis.ping(),
      'auth-service': () => ping(config.AUTH_SERVICE_URL),
      'events-service': () => ping(config.EVENTS_SERVICE_URL),
      'orders-service': () => ping(config.ORDERS_SERVICE_URL),
      'payments-service': () => ping(config.PAYMENTS_SERVICE_URL),
    },
  })

  await app.register(helmet)
  await app.register(cors, {
    origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',').map((o) => o.trim()),
    exposedHeaders: ['x-request-id', 'x-cache', 'idempotent-replayed', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'],
  })

  // Si la request trae token, se valida acá: un token inválido se rechaza sin
  // llegar a los servicios, y la identidad se usa como clave del rate limit.
  // Cada servicio vuelve a validarlo igual (defensa en profundidad).
  app.addHook('onRequest', async (req) => {
    if (AUTH_PREFIXES.some((p) => req.url.startsWith(p))) return
    const token = extractBearerToken(req)
    if (token) req.auth = await deps.verifyToken(token)
  })

  // Rate limit distribuido: los contadores viven en Redis, así que el límite
  // se respeta aunque haya varias réplicas del gateway detrás de un balanceador.
  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis: deps.redis,
    nameSpace: 'gateway:ratelimit:',
    keyGenerator: (req) => (req.auth ? `user:${req.auth.userId}` : `ip:${req.ip}`),
    // Si Redis se cae preferimos dejar pasar tráfico (fail-open) antes que tirar toda la API.
    skipOnError: true,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Demasiadas requests; reintentá en ${ctx.after}`,
    }),
  })

  const upstreams: { prefix: string; url: string }[] = [
    { prefix: '/auth', url: config.AUTH_SERVICE_URL },
    { prefix: '/.well-known', url: config.AUTH_SERVICE_URL },
    { prefix: '/events', url: config.EVENTS_SERVICE_URL },
    { prefix: '/organizer', url: config.EVENTS_SERVICE_URL },
    { prefix: '/orders', url: config.ORDERS_SERVICE_URL },
    { prefix: '/availability', url: config.ORDERS_SERVICE_URL },
    { prefix: '/payments', url: config.PAYMENTS_SERVICE_URL },
    // Webhooks de la pasarela: públicos, autenticados por firma HMAC en payments-service.
    { prefix: '/webhooks', url: config.PAYMENTS_SERVICE_URL },
  ]

  for (const { prefix, url } of upstreams) {
    await app.register(proxy, {
      upstream: url,
      prefix,
      rewritePrefix: prefix,
      undici: {
        headersTimeout: config.UPSTREAM_TIMEOUT_MS,
        bodyTimeout: config.UPSTREAM_TIMEOUT_MS,
        connect: { timeout: 2000 },
      },
      replyOptions: {
        rewriteRequestHeaders: (req, headers) => ({
          ...headers,
          // El servicio recibe el mismo request id que el gateway: un id, todos los logs.
          'x-request-id': req.id,
          // IP real del cliente para los servicios (ej.: rate limit de login en auth).
          // Se reemplaza, no se concatena: no reenviamos lo que haya inventado el cliente.
          'x-forwarded-for': req.ip,
        }),
        onError: (reply, { error }) => {
          const { status, body } = upstreamErrorBody(error)
          reply.log.warn({ err: error.message, upstream: url }, 'servicio no disponible')
          void reply.status(status).send(body)
        },
      },
    })
  }

  return app
}
