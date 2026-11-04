import { type Pool, registerDbGauge, registerOutboxGauge } from '@ticketflow/common'

export function registerBusinessMetrics(pool: Pool) {
  registerOutboxGauge(pool)
  registerDbGauge({
    name: 'ticketflow_orders',
    help: 'Órdenes, por estado',
    db: pool,
    label: 'status',
    query: `SELECT status AS label, count(*)::int AS value FROM orders GROUP BY status`,
  })
  registerDbGauge({
    name: 'ticketflow_seats',
    help: 'Asientos del inventario, por estado efectivo (una reserva vencida cuenta como disponible)',
    db: pool,
    label: 'status',
    query: `SELECT CASE WHEN status = 'held' AND held_until <= now() THEN 'available' ELSE status END AS label,
                   count(*)::int AS value
              FROM seats GROUP BY 1`,
  })
  registerDbGauge({
    name: 'ticketflow_revenue_cents',
    help: 'Facturación de órdenes pagadas (en centavos), por moneda',
    db: pool,
    label: 'currency',
    query: `SELECT currency AS label, coalesce(sum(total_cents), 0)::bigint AS value
              FROM orders WHERE status = 'paid' GROUP BY currency`,
  })
}
