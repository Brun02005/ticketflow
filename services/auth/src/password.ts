import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Hash de contraseñas con scrypt (incluido en Node, sin dependencias nativas).
 *
 * Formato guardado: scrypt$N$r$p$<salt base64>$<hash base64>
 * Los parámetros viajan junto al hash, así que se puede subir el costo en el
 * futuro sin invalidar las contraseñas existentes.
 */
const DEFAULT_PARAMS = { N: 2 ** 15, r: 8, p: 1 }
const KEY_LENGTH = 64
const SALT_LENGTH = 16

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

// scrypt usa 128 * N * r bytes de memoria; subimos el límite por defecto (32 MiB).
const maxmemFor = (N: number, r: number) => 128 * N * r * 2

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = DEFAULT_PARAMS
  const salt = randomBytes(SALT_LENGTH)
  const hash = await scryptAsync(password, salt, KEY_LENGTH, { N, r, p, maxmem: maxmemFor(N, r) })
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$')
  if (algo !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false

  const expected = Buffer.from(hashB64, 'base64')
  const N = Number(n)
  const R = Number(r)
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N,
    r: R,
    p: Number(p),
    maxmem: maxmemFor(N, R),
  })
  // Comparación en tiempo constante: no filtra cuántos bytes coinciden.
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

let dummyHash: Promise<string> | undefined

/**
 * Cuando el email no existe igual calculamos un hash, para que el tiempo de
 * respuesta sea el mismo y no se pueda averiguar qué emails están registrados.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing')
  await verifyPassword(password, await dummyHash)
}
