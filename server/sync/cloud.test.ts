import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../db.ts'
import { SqliteTasteStore } from '../store.ts'
import { SyncService } from './service.ts'
import { signIn } from './sign-in.testing.ts'

describe('offline', () => {
  it('keeps changes queued, reports offline and backs off, without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexttupp-sync-'))
    const db = openDb(':memory:')
    const store = new SqliteTasteStore(db)
    let calls = 0
    const fetchImpl = (async (url: string) => {
      calls++
      if (String(url).endsWith('/v1/auth/ticket')) {
        return Response.json({ token: `nxs_${'a'.repeat(43)}`, expiresAt: Date.now() + 1e9, account: { id: '11111111-1111-4111-8111-111111111111', email: 'me@example.com', displayName: null, role: 'member', createdAt: 0 } })
      }
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const sync = new SyncService({ db, store, dataDir: dir, cloudUrl: 'https://cloud.invalid', fetch: fetchImpl })
    try {
      const p = store.defaultProfile()
      store.setRating(p.id, { id: 'tt0112471', type: 'movie' }, 1)
      const status = await signIn(sync)
      expect(status.signedIn).toBe(true)
      expect(status.sync).toMatchObject({ state: 'offline', lastSyncAt: null })
      expect(status.sync!.pending).toBeGreaterThan(0)
      expect(status.sync!.retryAt).toBeGreaterThan(Date.now())
      expect(JSON.stringify(status)).not.toContain('nxs_')
      // The token is kept on disk for this user only.
      expect(statSync(join(dir, 'account.json')).mode & 0o777).toBe(0o600)
      const before = calls
      sync.nudge() // waiting out the outage: no new attempt
      expect(calls).toBe(before)
      const out = await sync.logout()
      expect(out.signedIn).toBe(false)
      expect(store.titleState(p.id, { id: 'tt0112471', type: 'movie' }).rating).toBe(1)
    } finally {
      sync.stop()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
