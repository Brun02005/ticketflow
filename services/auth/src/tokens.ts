import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { type AuthContext, createTokenVerifier, type TokenVerifier } from '@ticketflow/common'
import { SignJWT } from 'jose'
import type { SigningKeys } from './keys'

export type AccessTokenClaims = AuthContext

export interface TokenIssuerOptions {
  issuer: string
  audience: string
  accessTtlSeconds: number
}

export class TokenIssuer {
  /** Mismo verificador que usan los demás servicios, pero con la clave local. */
  readonly verifyAccessToken: TokenVerifier

  constructor(
    private readonly keys: SigningKeys,
    readonly options: TokenIssuerOptions,
  ) {
    this.verifyAccessToken = createTokenVerifier({
      key: keys.publicKey,
      issuer: options.issuer,
      audience: options.audience,
    })
  }

  signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ role: claims.role })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keys.kid, typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.options.accessTtlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.keys.privateKey)
  }

  get jwks() {
    return { keys: [this.keys.publicJwk] }
  }
}

/**
 * Los refresh tokens son opacos (no JWT): 256 bits aleatorios.
 * En la base solo guardamos su SHA-256; si se filtra la tabla, los tokens no sirven.
 * Alcanza con SHA-256 (no hace falta scrypt) porque tienen entropía alta, no son contraseñas.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashRefreshToken(token) }
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
