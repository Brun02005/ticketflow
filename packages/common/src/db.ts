import pg from 'pg'

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient
/** Algo que puede ejecutar queries: el pool o un cliente dentro de una transacción. */
export type Queryable = Pick<pg.Pool, 'query'>

export function createPool(connectionString: string, options: pg.PoolConfig = {}): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, ...options })
}

/**
 * Ejecuta `fn` dentro de una transacción. Hace COMMIT si termina bien
 * y ROLLBACK si lanza, y siempre devuelve el cliente al pool.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
