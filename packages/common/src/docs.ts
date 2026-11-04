import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { HttpApp } from './http'

/** Registra OpenAPI + Swagger UI en /docs. Llamar antes de registrar las rutas. */
export async function registerDocs(app: HttpApp, info: { title: string; version: string }) {
  await app.register(swagger, {
    openapi: {
      info,
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  })
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true })
}
