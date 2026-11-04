import { type Pool, registerDbGauge } from '@ticketflow/common'

export function registerBusinessMetrics(pool: Pool) {
  registerDbGauge({
    name: 'ticketflow_notifications',
    help: 'Notificaciones, por estado (failed > 0 requiere atención)',
    db: pool,
    label: 'status',
    query: `SELECT status AS label, count(*)::int AS value FROM notifications GROUP BY status`,
  })
}
