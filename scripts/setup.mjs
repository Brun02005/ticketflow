// Prepara el entorno local (se puede correr las veces que haga falta):
//  - copia services/*/.env.example → .env si no existe; si existe, le agrega las
//    variables nuevas del ejemplo sin tocar las que ya tenías
//  - genera los secretos de docker compose en el .env de la raíz
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

for (const service of readdirSync(join(root, 'services'))) {
  const example = join(root, 'services', service, '.env.example')
  const target = join(root, 'services', service, '.env')
  if (!existsSync(example)) continue
  if (!existsSync(target)) {
    copyFileSync(example, target)
    console.log(`✓ services/${service}/.env creado`)
    continue
  }
  const current = readFileSync(target, 'utf8')
  const defined = new Set([...current.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]))
  const missing = readFileSync(example, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line) && !defined.has(line.split('=')[0]))
  if (missing.length > 0) {
    writeFileSync(target, `${current.replace(/\n?$/, '\n')}${missing.join('\n')}\n`)
    console.log(`✓ services/${service}/.env: agregadas ${missing.map((l) => l.split('=')[0]).join(', ')}`)
  }
}

// Secretos para docker compose (.env de la raíz). En desarrollo cada servicio
// usa los valores de su .env.example, que coinciden entre sí.
const rootEnv = join(root, '.env')
let env = existsSync(rootEnv) ? readFileSync(rootEnv, 'utf8') : ''
const ensure = (name, generate, label) => {
  if (new RegExp(`^${name}=.+`, 'm').test(env)) return
  env = `${env.replace(new RegExp(`^${name}=.*\\n?`, 'm'), '')}${name}=${generate()}\n`
  console.log(`✓ ${label} generado en .env (para docker compose)`)
}

ensure(
  'JWT_PRIVATE_KEY',
  () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    return `"${pem.trim().replace(/\n/g, '\\n')}"`
  },
  'clave JWT',
)
ensure('PSP_API_KEY', () => `sk_test_${randomBytes(16).toString('hex')}`, 'API key de la pasarela')
ensure('PSP_WEBHOOK_SECRET', () => `whsec_${randomBytes(24).toString('hex')}`, 'secreto de webhooks')
ensure('TICKET_SIGNING_SECRET', () => randomBytes(32).toString('base64url'), 'secreto de firma de entradas')
writeFileSync(rootEnv, env)

console.log('Listo. Siguiente paso: npm run infra:up && npm run dev')
