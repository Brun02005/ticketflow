import type { KeyObject } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { ForbiddenError, UnauthorizedError } from './errors'

export type Role = 'customer' | 'organizer' | 'admin'
const ROLES: readonly Role[] = ['customer', 'organizer', 'admin']

/** Identidad del usuario extraída del access token. */
export interface AuthContext {
  userId: string
  role: Role
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
}

export type TokenVerifier = (token: string) => Promise<AuthContext>

export interface TokenVerifierOptions {
  /** Clave pública, o una función que la resuelve por `kid` (ej.: JWKS remoto). */
  key: KeyObject | JWTVerifyGetKey
  issuer: string
  audience: string
}

export function createTokenVerifier(opts: TokenVerifierOptions): TokenVerifier {
  const verifyOptions = {
    issuer: opts.issuer,
    audience: opts.audience,
    algorithms: ['EdDSA'], // nunca confiar en el `alg` que declara el token
  }

  return async (token) => {
    try {
      const { payload } =
        typeof opts.key === 'function'
          ? await jwtVerify(token, opts.key, verifyOptions)
          : await jwtVerify(token, opts.key, verifyOptions)

      const role = payload.role as Role
      if (typeof payload.sub !== 'string' || !ROLES.includes(role)) {
        throw new UnauthorizedError('INVALID_TOKEN', 'Access token inválido')
      }
      return { userId: payload.sub, role }
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err
      if (err instanceof joseErrors.JWTExpired) {
        throw new UnauthorizedError('TOKEN_EXPIRED', 'El access token expiró')
      }
      throw new UnauthorizedError('INVALID_TOKEN', 'Access token inválido')
    }
  }
}

/**
 * JWKS remoto de auth-service. jose cachea las claves y solo vuelve a pedirlas
 * cuando aparece un `kid` desconocido (rotación de claves), con un cooldown
 * para que un token basura no dispare una request por cada intento.
 */
export function remoteJwks(url: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 })
}

export function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

/** Hook onRequest: exige un access token válido y deja la identidad en `req.auth`. */
export function requireAuth(verify: TokenVerifier) {
  return async (req: FastifyRequest) => {
    const token = extractBearerToken(req)
    if (!token) {
      throw new UnauthorizedError('MISSING_TOKEN', 'Falta el header Authorization: Bearer <token>')
    }
    req.auth = await verify(token)
  }
}

/** Hook onRequest: si viene token lo valida (y rechaza si es inválido); si no viene, sigue como anónimo. */
export function optionalAuth(verify: TokenVerifier) {
  return async (req: FastifyRequest) => {
    const token = extractBearerToken(req)
    if (token) req.auth = await verify(token)
  }
}

/** Hook onRequest: exige que el usuario autenticado tenga alguno de los roles. Va después de requireAuth. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest) => {
    if (!req.auth) throw new UnauthorizedError()
    if (!roles.includes(req.auth.role)) {
      throw new ForbiddenError('INSUFFICIENT_ROLE', `Requiere rol: ${roles.join(' o ')}`)
    }
  }
}
