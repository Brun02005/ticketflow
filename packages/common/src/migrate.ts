import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from './db'

// Clave arbitraria para el advisory lock: evita que dos réplicas
// del mismo servicio corran migraciones a la vez al arrancar.
const MIGRATION_LOCK_KEY = 72_120_001

interface MigrationLogger {
  info(msg: string): void
}

/**
 * Migrador mínimo basado en archivos SQL numerados (001_init.sql, 002_...).
 * Cada migración corre en su propia transacción y queda registrada en
 * `schema_migrations`, así que es idempotente: correrlo dos veces no hace nada.
 */
export async function runMigrations(
  pool: Pool,
  dir: string,
  logger: MigrationLogger = console,
): Promise<string[]> {
  const client = await pool.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`)

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const done = new Set(rows.map((r) => r.name))
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Falló la migración ${file}: ${(err as Error).message}`, { cause: err })
      }
      applied.push(file)
      logger.info(`migración aplicada: ${file}`)
    }
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {})
    client.release()
  }
}
