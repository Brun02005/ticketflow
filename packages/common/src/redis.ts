import { Redis } from 'ioredis'

export type { Redis }

/**
 * Cliente Redis configurado para fallar rápido: si Redis no está, los comandos
 * fallan enseguida en vez de quedar encolados. Así quien lo usa (caché, rate
 * limit) puede degradar con elegancia en lugar de colgar las requests.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  })
}

/** Espera a que el cliente esté conectado (útil en tests y scripts). */
export async function waitForRedis(redis: Redis): Promise<void> {
  if (redis.status === 'ready') return
  await new Promise<void>((resolve, reject) => {
    redis.once('ready', resolve)
    redis.once('end', () => reject(new Error('No se pudo conectar a Redis')))
  })
}
