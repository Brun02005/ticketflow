interface Logger {
  error(obj: object, msg?: string): void
}

/**
 * Tarea en segundo plano que se repite cada `intervalMs`. Nunca se superpone
 * consigo misma (la próxima corrida se agenda cuando termina la anterior) y
 * `stop()` espera a que termine la corrida en curso: apagado ordenado.
 */
export class PeriodicTask {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<unknown> | null = null
  private stopped = true

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<unknown>,
    private readonly logger: Logger,
  ) {}

  start() {
    this.stopped = false
    const tick = async () => {
      if (this.stopped) return
      this.running = this.fn().catch((err) => this.logger.error({ err, task: this.name }, 'falló la tarea periódica'))
      await this.running
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs)
    }
    this.timer = setTimeout(tick, this.intervalMs)
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.running
  }
}
