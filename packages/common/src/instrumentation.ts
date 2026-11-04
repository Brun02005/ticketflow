/**
 * Arranque de OpenTelemetry. Se carga con `node --import` ANTES que la app,
 * para que las instrumentaciones automáticas puedan parchear http, pg,
 * ioredis, undici y pino cuando la app los importe.
 *
 * Solo se activa si hay un colector configurado (OTEL_EXPORTER_OTLP_ENDPOINT):
 * en tests y en desarrollo no agrega ningún costo.
 */
import { register } from 'node:module'

declare global {
  // eslint-disable-next-line no-var
  var __otelShutdown: (() => Promise<void>) | undefined
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // Hook de carga para módulos ESM (los CJS se parchean con require-in-the-middle).
  // Modo selectivo: el loader solo envuelve los módulos que alguna instrumentación
  // pidió. Envolver todo rompía librerías con re-exports de namespaces (TypeBox:
  // "Type.IsTemplateLiteral is not a function").
  const { createAddHookMessageChannel } = await import('import-in-the-middle')
  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel()
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions)

  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Ruido sin valor para este proyecto.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // La propagación por RabbitMQ la hacemos a mano para atravesar el outbox (ver tracing.ts).
        '@opentelemetry/instrumentation-amqplib': { enabled: false },
        // Los health checks no son tráfico real.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => req.url?.startsWith('/health') ?? false,
        },
      }),
    ],
  })
  sdk.start()
  // Antes de dejar arrancar la app, el loader tiene que conocer todos los módulos a envolver.
  await waitForAllMessagesAcknowledged()
  // startServer lo llama al apagar, para no perder los últimos spans en memoria.
  globalThis.__otelShutdown = () => sdk.shutdown()
}
