import { randomUUID } from 'node:crypto'
import {
  enqueueOutbox,
  NotFoundError,
  type Pool,
  type Queryable,
  UnauthorizedError,
  withTransaction,
} from '@ticketflow/common'
import { burnPasswordCheck, hashPassword, verifyPassword } from './password'
import { type Role, refreshTokenRepository, type User, userRepository } from './repository'
import { generateRefreshToken, hashRefreshToken, type TokenIssuer } from './tokens'

export interface TokenPair {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  expiresIn: number
}

export interface PublicUser {
  id: string
  email: string
  role: Role
  createdAt: string
}

const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt.toISOString(),
})

const DAY_MS = 24 * 60 * 60 * 1000

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly tokens: TokenIssuer,
    private readonly options: { refreshTtlDays: number },
  ) {}

  async register(input: { email: string; password: string; role?: Role }) {
    // El hash (lento a propósito) se calcula fuera de la transacción para no
    // tener una conexión tomada mientras tanto.
    const passwordHash = await hashPassword(input.password)
    return withTransaction(this.pool, async (tx) => {
      const user = await userRepository.create(tx, {
        email: input.email.trim().toLowerCase(),
        passwordHash,
        role: input.role ?? 'customer',
      })
      const tokens = await this.issueTokens(tx, user, randomUUID())
      // Otros servicios (notificaciones) necesitan el email: se publica en el mismo commit.
      await enqueueOutbox(tx, {
        type: 'user.registered',
        aggregateId: user.id,
        payload: { userId: user.id, email: user.email, role: user.role },
      })
      return { user: toPublicUser(user), tokens }
    })
  }

  async login(input: { email: string; password: string }) {
    const user = await userRepository.findByEmail(this.pool, input.email.trim())
    if (!user) {
      await burnPasswordCheck(input.password)
      throw invalidCredentials()
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      throw invalidCredentials()
    }
    // Cada login inicia una familia nueva de refresh tokens (una por dispositivo/sesión).
    const tokens = await this.issueTokens(this.pool, user, randomUUID())
    return { user: toPublicUser(user), tokens }
  }

  /**
   * Rotación de refresh token con detección de reutilización.
   * - Token válido: se revoca y se emite uno nuevo de la misma familia.
   * - Token ya revocado: alguien lo está reutilizando (posible robo), así que
   *   se revoca la familia completa y el usuario tiene que volver a loguearse.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const outcome = await withTransaction(this.pool, async (tx) => {
      const record = await refreshTokenRepository.findByHashForUpdate(tx, hashRefreshToken(refreshToken))
      if (!record) return { kind: 'invalid' as const }

      if (record.revokedAt) {
        await refreshTokenRepository.revokeFamily(tx, record.familyId)
        return { kind: 'reused' as const }
      }
      if (record.expiresAt.getTime() <= Date.now()) return { kind: 'expired' as const }

      const user = await userRepository.findById(tx, record.userId)
      if (!user) return { kind: 'invalid' as const }

      const next = generateRefreshToken()
      const nextId = await refreshTokenRepository.insert(tx, {
        userId: user.id,
        familyId: record.familyId,
        tokenHash: next.hash,
        expiresAt: new Date(Date.now() + this.options.refreshTtlDays * DAY_MS),
      })
      await refreshTokenRepository.markRotated(tx, record.id, nextId)
      return { kind: 'ok' as const, user, refreshToken: next.token }
    })

    // Los errores se lanzan fuera de la transacción: la revocación de la familia
    // tiene que quedar commiteada aunque la respuesta sea un 401.
    switch (outcome.kind) {
      case 'invalid':
        throw new UnauthorizedError('INVALID_REFRESH_TOKEN', 'Refresh token inválido')
      case 'expired':
        throw new UnauthorizedError('REFRESH_TOKEN_EXPIRED', 'El refresh token expiró')
      case 'reused':
        throw new UnauthorizedError(
          'REFRESH_TOKEN_REUSED',
          'Se detectó reutilización del refresh token; la sesión fue cerrada',
        )
      case 'ok':
        return this.buildPair(outcome.user, outcome.refreshToken)
    }
  }

  /** Cierra la sesión: revoca toda la familia del refresh token. Idempotente. */
  async logout(refreshToken: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const record = await refreshTokenRepository.findByHashForUpdate(tx, hashRefreshToken(refreshToken))
      if (record) await refreshTokenRepository.revokeFamily(tx, record.familyId)
    })
  }

  async getUser(id: string): Promise<PublicUser> {
    const user = await userRepository.findById(this.pool, id)
    if (!user) throw new NotFoundError('USER_NOT_FOUND', 'Usuario no encontrado')
    return toPublicUser(user)
  }

  private async issueTokens(db: Queryable, user: User, familyId: string): Promise<TokenPair> {
    const refresh = generateRefreshToken()
    await refreshTokenRepository.insert(db, {
      userId: user.id,
      familyId,
      tokenHash: refresh.hash,
      expiresAt: new Date(Date.now() + this.options.refreshTtlDays * DAY_MS),
    })
    return this.buildPair(user, refresh.token)
  }

  private async buildPair(user: User, refreshToken: string): Promise<TokenPair> {
    return {
      accessToken: await this.tokens.signAccessToken({ userId: user.id, role: user.role }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.options.accessTtlSeconds,
    }
  }
}

const invalidCredentials = () => new UnauthorizedError('INVALID_CREDENTIALS', 'Email o contraseña incorrectos')
