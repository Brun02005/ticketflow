import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { calculateJwkThumbprint, exportJWK, type JWK } from 'jose'

/**
 * Los access tokens se firman con Ed25519 (asimétrico). Solo auth-service tiene
 * la clave privada; el resto de los servicios valida con la clave pública que
 * se publica en /.well-known/jwks.json. Así ningún otro servicio puede emitir tokens.
 */
export interface SigningKeys {
  privateKey: KeyObject
  publicKey: KeyObject
  publicJwk: JWK
  kid: string
}

export async function loadSigningKeys(privateKeyPem?: string): Promise<SigningKeys> {
  const privateKey = privateKeyPem
    ? createPrivateKey(privateKeyPem.replace(/\\n/g, '\n'))
    : generateKeyPairSync('ed25519').privateKey

  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`JWT_PRIVATE_KEY debe ser Ed25519, se recibió ${privateKey.asymmetricKeyType}`)
  }

  const publicKey = createPublicKey(privateKey)
  const jwk = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(jwk)
  return {
    privateKey,
    publicKey,
    publicJwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' },
    kid,
  }
}

export function generatePrivateKeyPem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}
