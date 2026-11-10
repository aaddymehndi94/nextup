import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Tests run inside workerd against a local, in-memory D1 with the real migrations applied.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname)
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, PUBLIC_URL: 'https://cloud.test' } },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], testTimeout: 30_000 },
  }
})
