import type { D1Migration } from 'cloudflare:test'

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      PUBLIC_URL: string
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
