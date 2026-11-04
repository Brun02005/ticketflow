/**
 * globalSetup de Vitest: crea un vhost de RabbitMQ exclusivo para los tests.
 *
 * Sin esto, los tests publicaban en el mismo exchange que usa el sistema en
 * ejecución (docker compose / npm run dev) y sus mensajes de prueba terminaban
 * en las DLQ de los servicios reales. Un vhost es un broker lógico aparte:
 * exchanges, colas y bindings totalmente aislados.
 */
export const TEST_VHOST = 'ticketflow_test'

export default async function setup() {
  const api = process.env.TEST_RABBITMQ_API ?? 'http://localhost:15672'
  const auth = `Basic ${Buffer.from('guest:guest').toString('base64')}`
  const vhost = encodeURIComponent(TEST_VHOST)

  const put = async (path: string, body: unknown) => {
    const res = await fetch(`${api}${path}`, {
      method: 'PUT',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`RabbitMQ ${path}: HTTP ${res.status} ${await res.text()}`)
  }

  // Idempotentes: si ya existen, no pasa nada.
  await put(`/api/vhosts/${vhost}`, {})
  await put(`/api/permissions/${vhost}/guest`, { configure: '.*', write: '.*', read: '.*' })
}
