import { registerDbGauge, registerOutboxGauge, type Pool } from '@ticketflow/common'

export function registerBusinessMetrics(pool: Pool) {
  registerOutboxGauge(pool)
  registerDbGauge({
    name: 'ticketflow_users',
    help: 'Usuarios registrados, por rol',
    db: pool,
    label: 'role',
    query: `SELECT role AS label, count(*)::int AS value FROM users GROUP BY role`,
  })
}
