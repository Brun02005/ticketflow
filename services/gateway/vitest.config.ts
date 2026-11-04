import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'gateway',
    include: ['test/**/*.test.ts'],
    // Los archivos de un servicio comparten su base de test: corren de a uno.
    fileParallelism: false,
    env: {
      // Base 14 de Redis: aislada del resto.
      TEST_REDIS_URL: process.env.GATEWAY_TEST_REDIS_URL ?? 'redis://localhost:6379/14',
    },
  },
})
