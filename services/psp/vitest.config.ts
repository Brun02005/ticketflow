import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'psp',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
  },
})
