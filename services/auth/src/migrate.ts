import { fileURLToPath } from 'node:url'
import { createPool, runMigrations } from '@ticketflow/common'
import { loadConfig } from './config'

const config = loadConfig()
const pool = createPool(config.DATABASE_URL)
try {
  const applied = await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)))
  console.log(applied.length ? `${applied.length} migraciones aplicadas` : 'Base al día')
} finally {
  await pool.end()
}
