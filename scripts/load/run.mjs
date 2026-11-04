// Corre la prueba de carga con k6 dentro de Docker (no hace falta instalar k6).
//
// 1. Recrea auth-service y api-gateway con límites de rate limit altos: si no,
//    el propio rate limit (que funciona bien) frenaría la prueba antes de llegar
//    a los asientos.
// 2. Corre scripts/load/oversell.js contra el gateway, desde la red de Docker.
// 3. Restaura los límites normales, aunque la prueba falle.
//
// Variables opcionales: BUYERS, ROWS, PEAK_VUS, DURATION, LATENCY_P95_MS (se pasan a k6).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const K6_IMAGE = 'grafana/k6:2.2.0'

function compose(env, ...args) {
  const res = spawnSync('docker', ['compose', '--profile', 'app', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (res.status !== 0) throw new Error(`docker compose ${args.join(' ')} falló`)
}

const relaxed = { RATE_LIMIT_MAX: '1000000', LOGIN_RATE_LIMIT_MAX: '100000' }
console.log('→ Subiendo los límites de rate limit para la prueba...')
compose(relaxed, 'up', '-d', '--wait', '--no-deps', 'auth-service', 'api-gateway')

let status = 1
try {
  const passthrough = ['BUYERS', 'ROWS', 'PEAK_VUS', 'DURATION', 'LATENCY_P95_MS'].flatMap((name) =>
    process.env[name] ? ['-e', `${name}=${process.env[name]}`] : [],
  )
  const k6 = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'ticketflow_default',
      '-e',
      'BASE_URL=http://api-gateway:3000',
      ...passthrough,
      K6_IMAGE,
      'run',
      '-',
    ],
    { input: readFileSync(new URL('./oversell.js', import.meta.url)), stdio: ['pipe', 'inherit', 'inherit'] },
  )
  status = k6.status ?? 1
} finally {
  console.log('→ Restaurando los límites normales...')
  compose({}, 'up', '-d', '--wait', '--no-deps', 'auth-service', 'api-gateway')
}
process.exit(status)
