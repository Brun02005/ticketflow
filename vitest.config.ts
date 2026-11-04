import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['services/*'],
    // Los tests de integración comparten la base de cada servicio: corren en serie.
    fileParallelism: false,
  },
})
