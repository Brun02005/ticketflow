// Prepara el entorno local:
//  - copia services/*/.env.example → .env (si no existe)
//  - genera la clave Ed25519 de auth-service en el .env de la raíz (lo usa docker compose)
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

for (const service of readdirSync(join(root, 'services'))) {
  const example = join(root, 'services', service, '.env.example')
  const target = join(root, 'services', service, '.env')
  if (existsSync(example) && !existsSync(target)) {
    copyFileSync(example, target)
    console.log(`✓ services/${service}/.env creado`)
  }
}

// Secretos para docker compose (.env de la raíz). En desarrollo cada servicio
// usa los valores de su .env.example, que coinciden entre sí.
const rootEnv = join(root, '.env')
let env = existsSync(rootEnv) ? readFileSync(rootEnv, 'utf8') : ''
const ensure = (name, generate, label) => {
  if (new RegExp(`^${name}=.+`, 'm').test(env)) return
  env = env.replace(new RegExp(`^${name}=.*\\n?`, 'm'), '') + `${name}=${generate()}\n`
  console.log(`✓ ${label} generado en .env (para docker compose)`)
}

ensure('JWT_PRIVATE_KEY', () => {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return `"${pem.trim().replace(/\n/g, '\\n')}"`
}, 'clave JWT')
ensure('PSP_API_KEY', () => `sk_test_${randomBytes(16).toString('hex')}`, 'API key de la pasarela')
ensure('PSP_WEBHOOK_SECRET', () => `whsec_${randomBytes(24).toString('hex')}`, 'secreto de webhooks')
writeFileSync(rootEnv, env)

console.log('Listo. Siguiente paso: npm run infra:up && npm run dev')
