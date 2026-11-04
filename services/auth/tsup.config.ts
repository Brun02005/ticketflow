import { defineConfig } from 'tsup'

// Empaqueta el servicio en un único archivo, incluyendo el código de
// @ticketflow/common (que en el repo es TypeScript sin compilar).
export default defineConfig({
  entry: ['src/instrumentation.ts', 'src/server.ts', 'src/migrate.ts'],
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  // Las dependencias de npm quedan externas (se instalan en la imagen);
  // solo se embebe @ticketflow/common, que en el repo es TypeScript sin compilar.
  skipNodeModulesBundle: true,
  noExternal: ['@ticketflow/common'],
})
