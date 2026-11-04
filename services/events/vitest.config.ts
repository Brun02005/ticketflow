import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'events',
    include: ['test/**/*.test.ts'],
    // Los archivos de un servicio comparten su base de test: corren de a uno.
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL:
        process.env.EVENTS_TEST_DATABASE_URL ?? 'postgres://ticketflow:ticketflow@localhost:5432/events_test',
      // Base 15 de Redis: aislada de la que usa el servicio en desarrollo.
      TEST_REDIS_URL: process.env.EVENTS_TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      TEST_RABBITMQ_URL: process.env.TEST_RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',
    },
  },
})
