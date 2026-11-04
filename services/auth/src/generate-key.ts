// Genera una clave privada Ed25519 para firmar access tokens.
// Uso: npm run keys -w @ticketflow/auth-service
import { generatePrivateKeyPem } from './keys'

const pem = generatePrivateKeyPem()
console.log(pem)
console.log('Para .env (en una sola línea):')
console.log(`JWT_PRIVATE_KEY="${pem.trim().replace(/\n/g, '\\n')}"`)
