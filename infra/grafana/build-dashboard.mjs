// Dashboard como código: genera infra/grafana/dashboards/ticketflow.json.
// Uso: node infra/grafana/build-dashboard.mjs
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let nextId = 1
let y = 0
const DS = { type: 'prometheus', uid: 'prometheus' }

const row = (title) => {
  const panel = { id: nextId++, type: 'row', title, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] }
  y += 1
  return panel
}

/** Fila de paneles del mismo alto; cada panel declara su ancho. */
function line(height, panels) {
  let x = 0
  const built = panels.map((p) => {
    const panel = { ...p, id: nextId++, datasource: DS, gridPos: { x, y, w: p.w, h: height } }
    delete panel.w
    x += p.w
    return panel
  })
  y += height
  return built
}

const target = (expr, legendFormat = '') => ({ datasource: DS, expr, legendFormat, refId: String.fromCharCode(65) })

const stat = (title, expr, w, { unit = 'short', thresholds, description } = {}) => ({
  type: 'stat',
  title,
  description,
  w,
  targets: [target(expr)],
  options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value', graphMode: 'area' },
  fieldConfig: {
    defaults: {
      unit,
      thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'green', value: null }] },
    },
    overrides: [],
  },
})

const timeseries = (title, targets, w, { unit = 'short', description, stack = false } = {}) => ({
  type: 'timeseries',
  title,
  description,
  w,
  targets: targets.map(([expr, legend], i) => ({ ...target(expr, legend), refId: String.fromCharCode(65 + i) })),
  options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
  fieldConfig: {
    defaults: {
      unit,
      custom: { lineWidth: 2, fillOpacity: stack ? 30 : 10, stacking: { mode: stack ? 'normal' : 'none' } },
    },
    overrides: [],
  },
})

const alertWhenAboveZero = { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] }

const panels = [
  row('Negocio'),
  ...line(5, [
    stat('Asientos vendidos', 'sum(ticketflow_seats{status="sold"})', 4),
    stat('Asientos reservados (esperando pago)', 'sum(ticketflow_seats{status="held"})', 5),
    stat('Asientos disponibles', 'sum(ticketflow_seats{status="available"})', 5),
    stat('Facturación ARS', 'sum(ticketflow_revenue_cents{currency="ARS"}) / 100', 5, { unit: 'currency:$' }),
    stat('Usuarios registrados', 'sum(ticketflow_users)', 5),
  ]),
  ...line(8, [
    timeseries('Órdenes por estado', [['sum by (status) (ticketflow_orders)', '{{status}}']], 12, { stack: true }),
    timeseries('Pagos por estado', [['sum by (status) (ticketflow_payments)', '{{status}}']], 12, { stack: true }),
  ]),

  row('API'),
  ...line(8, [
    timeseries('Requests por segundo', [['sum by (service) (rate(http_server_request_duration_seconds_count[1m]))', '{{service}}']], 8, { unit: 'reqps' }),
    timeseries(
      'Latencia p95',
      [['histogram_quantile(0.95, sum by (le, service) (rate(http_server_request_duration_seconds_bucket[1m])))', '{{service}}']],
      8,
      { unit: 's' },
    ),
    timeseries(
      'Errores 5xx por segundo',
      // "or vector(0)": sin errores la serie no existe, y Grafana mostraría "No data" en lugar de 0.
      [['sum(rate(http_server_request_duration_seconds_count{status_code=~"5.."}[1m])) or vector(0)', 'errores 5xx']],
      8,
      { unit: 'reqps', description: 'Tiene que estar en cero: los conflictos de negocio son 409, no 5xx.' },
    ),
  ]),
  ...line(8, [
    timeseries(
      'Compras: concretadas vs. asiento ya tomado',
      [
        ['sum(rate(http_server_request_duration_seconds_count{service="orders-service",route="/orders",method="POST",status_code="201"}[1m]))', 'reservas creadas (201)'],
        ['sum(rate(http_server_request_duration_seconds_count{service="orders-service",route="/orders",method="POST",status_code="409"}[1m]))', 'asiento ya tomado (409)'],
      ],
      12,
      { unit: 'reqps', description: 'Bajo carga, la mayoría de los intentos choca contra asientos ya reservados. Eso es la protección contra sobreventa funcionando.' },
    ),
    timeseries(
      'Rate limit del gateway (429)',
      [['sum(rate(http_server_request_duration_seconds_count{service="api-gateway",status_code="429"}[1m])) or vector(0)', '429/s']],
      12,
      { unit: 'reqps' },
    ),
  ]),

  row('Mensajería y procesos en segundo plano'),
  ...line(5, [
    stat('Mensajes en DLQ', 'sum(rabbitmq_queue_messages{queue=~".*\\\\.dlq"}) or vector(0)', 6, {
      thresholds: alertWhenAboveZero,
      description: 'Mensajes que no se pudieron procesar. Tiene que ser cero.',
    }),
    stat('Outbox sin publicar', 'sum(outbox_pending_messages) or vector(0)', 6, {
      description: 'Si crece, RabbitMQ está caído o lento (la API sigue funcionando).',
    }),
    stat('Cobros en duda (> 1 min)', 'sum(ticketflow_charges_in_doubt) or vector(0)', 6, {
      thresholds: alertWhenAboveZero,
      description: 'Webhooks perdidos o pasarela sin respuesta: los resuelve la conciliación.',
    }),
    stat('Notificaciones fallidas', 'sum(ticketflow_notifications{status="failed"}) or vector(0)', 6, { thresholds: alertWhenAboveZero }),
  ]),
  ...line(8, [
    timeseries(
      'Mensajes consumidos por resultado',
      [['sum by (outcome) (rate(messages_processed_total[1m]))', '{{outcome}}']],
      8,
      { unit: 'ops' },
    ),
    timeseries('Mensajes publicados por tipo', [['sum by (type) (rate(outbox_published_total[1m]))', '{{type}}']], 8, { unit: 'ops' }),
    timeseries('Event loop lag p99', [['max by (service) (nodejs_eventloop_lag_p99_seconds)', '{{service}}']], 8, {
      unit: 's',
      description: 'Si sube, algo está bloqueando el hilo principal de Node.',
    }),
  ]),
]

const dashboard = {
  uid: 'ticketflow-overview',
  title: 'TicketFlow · Visión general',
  description: 'Negocio, API y mensajería de TicketFlow. Generado por infra/grafana/build-dashboard.mjs',
  tags: ['ticketflow'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '5s',
  time: { from: 'now-15m', to: 'now' },
  panels,
}

const out = fileURLToPath(new URL('./dashboards/ticketflow.json', import.meta.url))
writeFileSync(out, JSON.stringify(dashboard, null, 2) + '\n')
console.log(`Dashboard generado: ${panels.length} paneles`)
