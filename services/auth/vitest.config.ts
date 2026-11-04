import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'auth',
    include: ['test/**/*.test.ts'],
    // Los archivos de un servicio comparten su base de test: corren de a uno.
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL:
        process.env.AUTH_TEST_DATABASE_URL ?? 'postgres://ticketflow:ticketflow@localhost:5432/auth_test',
    },
  },
})
