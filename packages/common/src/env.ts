import type { Static, TSchema } from 'typebox'
import { Value } from 'typebox/value'

/**
 * Valida y tipa variables de entorno contra un schema de TypeBox.
 * Aplica defaults, convierte strings a números/booleanos y descarta claves ajenas.
 * Falla rápido al arrancar si falta algo: mejor romper en el deploy que en runtime.
 */
export function loadEnv<T extends TSchema>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): Static<T> {
  // Una variable definida pero vacía (FOO=) cuenta como no definida.
  const defined = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''))
  const value = Value.Convert(schema, Value.Default(schema, defined))
  if (!Value.Check(schema, value)) {
    const details = Value.Errors(schema, value)
      .map((e) => `  - ${e.instancePath || '(root)'} ${e.message}`)
      .join('\n')
    throw new Error(`Configuración de entorno inválida:\n${details}`)
  }
  return Value.Clean(schema, value) as Static<T>
}

/**
 * Interpreta TRUST_PROXY para Fastify: "true"/"false", o una lista de
 * IPs/CIDR/presets ("loopback", "10.0.0.0/8, 172.16.0.0/12").
 * Solo debe activarse si el servicio es alcanzable únicamente a través del
 * proxy; si no, cualquiera podría falsificar su IP con X-Forwarded-For.
 */
export function parseTrustProxy(value: string | undefined): boolean | string {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  return value
}
