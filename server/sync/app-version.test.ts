import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyBatch } from './local.ts'
import { openDb } from '../db.ts'
import { SqliteTasteStore } from '../store.ts'
import { SyncService } from './service.ts'

// The cloud's owner can turn away apps that are too old ("Update needed") and put one line in front of every
// app, through answers to calls the app makes anyway (cloud/src/index.ts). So the app says its version on every
// call, shows what it's told, and once it's too old, stops calling until it's updated.

const ACCOUNT = '11111111-1111-4111-8111-111111111111'

function cloud () {
  const calls: Array<{ path: string; app: string | null }> = []
  const answer = { tooOld: false, notice: null as string | null }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, app: new Headers(init?.headers).get('x-nexttupp-app') })
    const headers: Record<string, string> = answer.notice ? { 'x-nexttupp-notice': encodeURIComponent(answer.notice) } : {}
    if (answer.tooOld) return Response.json({ error: 'update_required', message: 'This version of nexttupp is too old to sync. Update to 0.6.0 or later.' }, { status: 426, headers })
    switch (path) {
      case '/v1/auth/code/verify': return Response.json({ token: `nxs_${'a'.repeat(43)}`, expiresAt: Date.now() + 1e10, account: { id: ACCOUNT, email: 'me@example.com', displayName: null, role: 'member', createdAt: 0 } }, { headers })
      case '/v1/sync/push': return Response.json({ applied: {}, serverTime: Date.now() }, { headers })
      case '/v1/sync/pull': return Response.json({ cursor: '1', more: false, serverTime: Date.now(), ...emptyBatch() }, { headers })
    }
    return Response.json({ error: 'not_found', message: 'Not found' }, { status: 404 })
  }) as typeof fetch
  return { calls, answer, fetchImpl }
}

describe('app versions and notices from the cloud', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let store: SqliteTasteStore
  let fake: ReturnType<typeof cloud>
  let sync: SyncService

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-15T12:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    dir = mkdtempSync(join(tmpdir(), 'nexttupp-version-'))
    db = openDb(':memory:')
    store = new SqliteTasteStore(db)
    fake = cloud()
    sync = new SyncService({ db, store, dataDir: dir, cloudUrl: 'https://cloud.invalid', fetch: fake.fetchImpl, appVersion: '0.5.5' })
    sync.start()
    await sync.verifyCode('me@example.com', '123456')
    await vi.advanceTimersByTimeAsync(10_000)
  })

  afterEach(() => {
    sync.stop()
    db.close()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const like = async () => {
    store.setRating(store.defaultProfile().id, { id: 'tt0112471', type: 'movie' }, 1)
    sync.nudge()
    await vi.advanceTimersByTimeAsync(15_000)
  }

  it('says its version on every call', async () => {
    await like()
    expect(fake.calls.length).toBeGreaterThan(1)
    expect(fake.calls.every(c => c.app === '0.5.5')).toBe(true)
  })

  it('shows the owner’s notice, and drops it once the cloud stops sending it', async () => {
    fake.answer.notice = 'Watch party is here — update to try it'
    await like()
    expect(sync.status().announcement).toBe('Watch party is here — update to try it')
    fake.answer.notice = null
    await sync.syncNow()
    expect(sync.status().announcement).toBeUndefined()
  })

  it('too old: says “update”, and makes no more calls until it’s updated', async () => {
    fake.answer.tooOld = true
    await like()
    expect(sync.status().updateRequired).toMatch(/Update to 0\.6\.0/)
    const made = fake.calls.length
    await like()
    sync.focus(true)
    await vi.advanceTimersByTimeAsync(48 * 3600_000)
    await sync.syncNow()
    expect(fake.calls.length).toBe(made)
  })
})
