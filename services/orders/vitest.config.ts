import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'orders',
    include: ['test/**/*.test.ts'],
    // Los archivos de un servicio comparten su base de test: corren de a uno.
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL:
        process.env.ORDERS_TEST_DATABASE_URL ?? 'postgres://ticketflow:ticketflow@localhost:5432/orders_test',
      TEST_RABBITMQ_URL: process.env.TEST_RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',
    },
  },
})
