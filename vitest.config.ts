import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts, whose root is web/.
export default defineConfig({
  test: { include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'web/**/*.test.ts'] },
})
