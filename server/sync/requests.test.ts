import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyBatch } from './local.ts'
import { openDb } from '../db.ts'
import { SqliteTasteStore } from '../store.ts'
import { SyncService } from './service.ts'
import { signIn } from './sign-in.testing.ts'

// When a computer calls the cloud: only on an event (a change here, the app opened or left, a new home address,
// "Sync now", quitting), never on a timer. The cloud only keeps likes, lists and the like, so a computer that
// nobody is using costs nothing, and one in use only what its changes need.

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const MIN = 60_000
const HOUR = 60 * MIN

function fakeCloud () {
  const calls: string[] = []
  let seq = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url))
    calls.push(`${init?.method ?? 'GET'} ${u.pathname.replace(/^\/v1\/devices\/.+$/, '/v1/devices/:id')}`)
    switch (u.pathname) {
      case '/v1/auth/ticket': return Response.json({ token: `nxs_${'a'.repeat(43)}`, expiresAt: Date.now() + 1e10, account: { id: ACCOUNT, email: 'me@example.com', displayName: null, role: 'member', createdAt: 0 } })
      case '/v1/sync/push': seq++; return Response.json({ applied: {}, serverTime: Date.now() })
      case '/v1/sync/pull': return Response.json({ cursor: String(seq), more: false, serverTime: Date.now(), ...emptyBatch() })
    }
    if (u.pathname.startsWith('/v1/devices/')) return Response.json({ device: {} })
    return Response.json({ error: 'not_found', message: 'Not found' }, { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('how often a computer calls the cloud', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let store: SqliteTasteStore
  let cloud: ReturnType<typeof fakeCloud>
  let sync: SyncService
  let lanUrls: string[]

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-15T12:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    dir = mkdtempSync(join(tmpdir(), 'nexttupp-requests-'))
    db = openDb(':memory:')
    store = new SqliteTasteStore(db)
    cloud = fakeCloud()
    lanUrls = ['http://192.168.1.20:4500']
    sync = new SyncService({
      db, store, dataDir: dir, cloudUrl: 'https://cloud.invalid', fetch: cloud.fetchImpl,
      device: () => ({ id: 'dev-1', name: 'Laptop (Linux)', platform: 'linux', lan: true, lanUrls }),
    })
    sync.start()
    await signIn(sync)
    await vi.advanceTimersByTimeAsync(10_000)
    cloud.calls.length = 0
  })

  afterEach(() => {
    sync.stop()
    db.close()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const like = (id: string) => store.setRating(store.defaultProfile().id, { id, type: 'movie' }, 1)

  it('a computer nobody is using makes no requests at all, however long it stays on', async () => {
    sync.focus(true)
    await vi.advanceTimersByTimeAsync(48 * HOUR)
    expect(cloud.calls).toEqual([])
  })

  it('the home-network check every minute doesn’t call the cloud, even days later, while nothing changes', async () => {
    for (let m = 0; m < 26 * 60; m++) {
      sync.deviceChanged()
      await vi.advanceTimersByTimeAsync(MIN)
    }
    expect(cloud.calls).toEqual([])
  })

  it('a like is uploaded a few seconds later, in one request, without asking for anything back', async () => {
    like('tt0112471')
    sync.nudge()
    like('tt0110912')
    sync.nudge()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(cloud.calls).toEqual(['POST /v1/sync/push'])
  })

  it('coming back to the app fetches the other computers’ changes; switching back and forth doesn’t', async () => {
    await vi.advanceTimersByTimeAsync(HOUR)
    sync.focus(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(cloud.calls).toEqual(['GET /v1/sync/pull'])
    for (let i = 0; i < 20; i++) {
      sync.focus(false)
      await vi.advanceTimersByTimeAsync(10_000)
      sync.focus(true)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(cloud.calls).toEqual(['GET /v1/sync/pull'])
  })

  it('watch progress waits for the player to close or the person to leave the app, then goes up once', async () => {
    const p = store.defaultProfile()
    for (let t = 0; t < 10 * MIN; t += 10_000) {
      store.recordProgress(p.id, { type: 'movie', id: 'tt0112471', streamId: 's1', position: t / 1000, duration: 7200 })
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(cloud.calls).toEqual([])
    sync.focus(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(cloud.calls).toEqual(['POST /v1/sync/push'])
  })

  it('a new home-network address is reported once, so phones keep finding the computer', async () => {
    sync.deviceChanged()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cloud.calls).toEqual([])
    lanUrls = ['http://192.168.1.31:4500']
    sync.deviceChanged()
    await vi.advanceTimersByTimeAsync(5000)
    sync.deviceChanged()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cloud.calls).toEqual(['PUT /v1/devices/:id'])
  })

  it('a computer on for days still says it’s there, alongside a sync it makes anyway', async () => {
    await vi.advanceTimersByTimeAsync(25 * HOUR)
    like('tt0112471')
    sync.nudge()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(cloud.calls).toEqual(['POST /v1/sync/push', 'PUT /v1/devices/:id'])
  })

  it('quitting uploads what’s waiting', async () => {
    store.recordProgress(store.defaultProfile().id, { type: 'movie', id: 'tt0112471', streamId: 's1', position: 600, duration: 7200 })
    await sync.flush()
    expect(cloud.calls).toEqual(['POST /v1/sync/push'])
  })

  it('“Sync now” still fetches straight away', async () => {
    await sync.syncNow()
    expect(cloud.calls).toContain('GET /v1/sync/pull')
  })
})
