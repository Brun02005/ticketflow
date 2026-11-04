import { registerDbGauge, registerOutboxGauge, type Pool } from '@ticketflow/common'

export function registerBusinessMetrics(pool: Pool) {
  registerOutboxGauge(pool)
  registerDbGauge({
    name: 'ticketflow_payments',
    help: 'Pagos, por estado',
    db: pool,
    label: 'status',
    query: `SELECT status AS label, count(*)::int AS value FROM payments GROUP BY status`,
  })
  registerDbGauge({
    name: 'ticketflow_charges_in_doubt',
    help: 'Cobros sin resultado hace más de un minuto (webhook perdido o pasarela sin respuesta)',
    db: pool,
    query: `SELECT count(*)::int AS value FROM charges
             WHERE status = 'processing' AND created_at < now() - interval '1 minute'`,
  })
}
