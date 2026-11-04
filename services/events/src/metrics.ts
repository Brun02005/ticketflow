import { registerDbGauge, registerOutboxGauge, type Pool } from '@ticketflow/common'

export function registerBusinessMetrics(pool: Pool) {
  registerOutboxGauge(pool)
  registerDbGauge({
    name: 'ticketflow_events',
    help: 'Eventos, por estado',
    db: pool,
    label: 'status',
    query: `SELECT status AS label, count(*)::int AS value FROM events GROUP BY status`,
  })
}
