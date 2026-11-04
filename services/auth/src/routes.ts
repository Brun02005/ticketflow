import { Type, requireAuth, type FastifyPluginAsyncTypebox } from '@ticketflow/common'
import type { TokenIssuer } from './tokens'
import type { AuthService } from './service'

const RoleSchema = Type.Union([Type.Literal('customer'), Type.Literal('organizer'), Type.Literal('admin')])

const UserSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  role: RoleSchema,
  createdAt: Type.String({ format: 'date-time' }),
})

const TokenPairSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  tokenType: Type.Literal('Bearer'),
  expiresIn: Type.Integer({ description: 'Segundos hasta que expira el access token' }),
})

const SessionSchema = Type.Object({ user: UserSchema, tokens: TokenPairSchema })

const Credentials = {
  email: Type.String({ format: 'email', maxLength: 254 }),
  password: Type.String({ minLength: 8, maxLength: 128 }),
}

const RefreshBody = Type.Object({ refreshToken: Type.String({ minLength: 1, maxLength: 256 }) })

const ErrorRef = { $ref: 'ErrorResponse#' }

export interface AuthRoutesOptions {
  service: AuthService
  tokens: TokenIssuer
  loginRateLimitMax: number
}

export const authRoutes: FastifyPluginAsyncTypebox<AuthRoutesOptions> = async (app, opts) => {
  const { service, tokens } = opts

  const authenticate = requireAuth(tokens.verifyAccessToken)

  // Limita intentos por IP para frenar fuerza bruta sobre contraseñas.
  const bruteForceLimit = {
    rateLimit: { max: opts.loginRateLimitMax, timeWindow: '1 minute' },
  }

  app.post(
    '/auth/register',
    {
      config: bruteForceLimit,
      schema: {
        tags: ['auth'],
        summary: 'Crear una cuenta',
        body: Type.Object({
          ...Credentials,
          role: Type.Optional(
            Type.Union([Type.Literal('customer'), Type.Literal('organizer')], {
              description: 'Los organizadores pueden publicar eventos. "admin" no se puede autoasignar.',
            }),
          ),
        }),
        response: { 201: SessionSchema, 400: ErrorRef, 409: ErrorRef, 429: ErrorRef },
      },
    },
    async (req, reply) => reply.status(201).send(await service.register(req.body)),
  )

  app.post(
    '/auth/login',
    {
      config: bruteForceLimit,
      schema: {
        tags: ['auth'],
        summary: 'Iniciar sesión',
        body: Type.Object(Credentials),
        response: { 200: SessionSchema, 401: ErrorRef, 429: ErrorRef },
      },
    },
    async (req) => service.login(req.body),
  )

  app.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotar el refresh token y obtener un access token nuevo',
        body: RefreshBody,
        response: { 200: TokenPairSchema, 401: ErrorRef },
      },
    },
    async (req) => service.refresh(req.body.refreshToken),
  )

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Cerrar sesión (revoca la familia del refresh token)',
        body: RefreshBody,
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      await service.logout(req.body.refreshToken)
      return reply.status(204).send(null)
    },
  )

  app.get(
    '/auth/me',
    {
      onRequest: authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Usuario autenticado',
        security: [{ bearerAuth: [] }],
        response: { 200: UserSchema, 401: ErrorRef },
      },
    },
    async (req) => service.getUser(req.auth!.userId),
  )

  app.get(
    '/.well-known/jwks.json',
    {
      schema: {
        tags: ['auth'],
        summary: 'Claves públicas para validar access tokens (JWKS)',
      },
    },
    async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=300')
      return tokens.jwks
    },
  )
}
