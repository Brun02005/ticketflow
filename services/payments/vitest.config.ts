import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'payments',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL:
        process.env.PAYMENTS_TEST_DATABASE_URL ?? 'postgres://ticketflow:ticketflow@localhost:5432/payments_test',
    },
  },
})
