import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'notifications',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL:
        process.env.NOTIFICATIONS_TEST_DATABASE_URL ??
        'postgres://ticketflow:ticketflow@localhost:5432/notifications_test',
      TEST_SMTP_HOST: process.env.TEST_SMTP_HOST ?? 'localhost',
      TEST_MAILPIT_API: process.env.TEST_MAILPIT_API ?? 'http://localhost:8025',
    },
  },
})
