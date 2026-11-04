import type { Redis } from '@ticketflow/common'
import type { EventDto } from './schemas'

interface Logger {
  warn(obj: object, msg?: string): void
}

/**
 * Caché cache-aside del detalle de eventos.
 *
 * - Lectura: primero Redis; si no está, la base, y se guarda con TTL.
 * - Escritura: después de commitear un cambio se borra la clave.
 * - El TTL acota cuánto puede durar un dato viejo si una lectura concurrente
 *   vuelve a cachear justo después de la invalidación.
 * - Si Redis está caído, se sigue funcionando contra la base (solo más lento).
 */
export class EventCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly logger: Logger,
  ) {}

  private key(id: string) {
    return `events:v1:${id}`
  }

  async get(id: string): Promise<EventDto | null> {
    try {
      const raw = await this.redis.get(this.key(id))
      return raw ? (JSON.parse(raw) as EventDto) : null
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'caché no disponible (lectura)')
      return null
    }
  }

  async set(event: EventDto): Promise<void> {
    try {
      await this.redis.set(this.key(event.id), JSON.stringify(event), 'EX', this.ttlSeconds)
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'caché no disponible (escritura)')
    }
  }

  async invalidate(id: string): Promise<void> {
    try {
      await this.redis.del(this.key(id))
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, eventId: id }, 'no se pudo invalidar la caché')
    }
  }
}
