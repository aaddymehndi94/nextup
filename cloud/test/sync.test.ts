import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/sync.ts'
import { call, makeAdmin, makeMember, profile, progressRow, pull, push, T0, type User } from './helpers.ts'

let admin: User
beforeAll(async () => { admin = await makeAdmin() })

const member = () => makeMember()

/** A push touching every section, as the local store would send it. */
function fullBatch (pid: string) {
  return {
    profiles: [profile({ id: pid, name: 'Aadi', avatar: '#ff8800' })],
    events: [
      { id: crypto.randomUUID(), profileId: pid, kind: 'rating', itemId: 'tt0133093', itemType: 'movie', value: 1, context: { source: 'title' }, at: T0 + 1 },
      { id: crypto.randomUUID(), profileId: pid, kind: 'play', itemId: 'tt0903747', itemType: 'series', value: 0.25, context: { streamId: 'tt0903747:1:2', position: 700, duration: 2800, watchedSec: 650 }, at: T0 + 2 },
      { id: crypto.randomUUID(), profileId: pid, kind: 'dismiss', itemId: 'tt0110912', itemType: 'movie', value: 1, context: { reason: 'seen' }, at: T0 + 3 },
      { id: crypto.randomUUID(), profileId: pid, kind: 'forget', itemId: 'tt0110912', itemType: 'movie', value: null, context: null, at: T0 + 4 },
      { id: crypto.randomUUID(), profileId: pid, kind: 'pref', itemId: null, itemType: null, value: -1, context: { feature: 'g:Horror' }, at: T0 + 5 },
    ],
    ratings: [{ profileId: pid, itemId: 'tt0133093', itemType: 'movie', value: 1, source: 'title', updatedAt: T0 + 1 }],
    list: [{ profileId: pid, itemId: 'tt0816692', itemType: 'movie', inList: 1, addedAt: T0 + 6, updatedAt: T0 + 6 }],
    progress: [
      progressRow(pid),
      progressRow(pid, { streamId: 'tt0903747:1:2', itemId: 'tt0903747', itemType: 'series', season: 1, episode: 2, position: 700, duration: 2800, maxPosition: 700, watchedSec: 650 }),
    ],
    dismissals: [{ profileId: pid, itemId: 'tt0110912', itemType: 'movie', reason: 'seen', updatedAt: T0 + 3 }],
    prefs: [{ profileId: pid, feature: 'd:christopher nolan', value: 1, updatedAt: T0 + 7 }],
  }
}

describe('push and pull', () => {
  it('round-trips every section exactly', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    const batch = fullBatch(pid)
    const r = await push(u, batch)
    expect(r.status).toBe(200)
    expect(r.body.applied).toEqual({ profiles: 1, events: 5, ratings: 1, list: 1, progress: 2, dismissals: 1, prefs: 1 })

    const p = await pull(u)
    expect(p.status).toBe(200)
    expect(p.body.more).toBe(false)
    expect(p.body.cursor).toBe('12')
    for (const s of ['profiles', 'events', 'ratings', 'list', 'progress', 'dismissals', 'prefs'] as const) {
      expect(p.body[s], s).toEqual(batch[s])
    }
  })

  it('is idempotent: pushing the same batch again changes nothing and moves no cursor', async () => {
    const u = await member()
    const batch = fullBatch(crypto.randomUUID())
    await push(u, batch)
    const first = await pull(u)
    const again = await push(u, batch)
    expect(again.status).toBe(200)
    expect(Object.values(again.body.applied).every(n => n === 0)).toBe(true)
    const after = await pull(u, first.body.cursor)
    expect(after.body.events).toEqual([])
    expect(after.body.ratings).toEqual([])
    expect(after.body.cursor).toBe(first.body.cursor)
    const full = await pull(u)
    expect(full.body.events).toHaveLength(5)
    expect(full.body.progress).toHaveLength(2)
  })

  it('pulls only what changed after the cursor, own pushes included', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    await push(u, fullBatch(pid))
    const c1 = (await pull(u)).body.cursor
    await push(u, { ratings: [{ profileId: pid, itemId: 'tt0133093', itemType: 'movie', value: -1, source: null, updatedAt: T0 + 100 }] })
    const p = await pull(u, c1)
    expect(p.body.ratings).toEqual([{ profileId: pid, itemId: 'tt0133093', itemType: 'movie', value: -1, source: null, updatedAt: T0 + 100 }])
    expect(p.body.profiles).toEqual([])
    expect(Number(p.body.cursor)).toBeGreaterThan(Number(c1))
  })

  it('pages through large pulls without gaps or repeats', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    const events = Array.from({ length: 40 }, (_, i) => ({ id: crypto.randomUUID(), profileId: pid, kind: 'list', itemId: `tt${1000 + i}`, itemType: 'movie', value: 1, context: null, at: T0 + i }))
    const list = Array.from({ length: 25 }, (_, i) => ({ profileId: pid, itemId: `tt${2000 + i}`, itemType: 'movie', inList: 1, addedAt: T0, updatedAt: T0 + i }))
    await push(u, { profiles: [profile({ id: pid })], events, list })
    const seen = { profiles: 0, events: new Set<string>(), list: new Set<string>() }
    let cursor = '0'
    let pages = 0
    for (;;) {
      const p = await pull(u, cursor, 7)
      expect(p.status).toBe(200)
      pages++
      const n = p.body.profiles.length + p.body.events.length + p.body.list.length
      expect(n).toBeLessThanOrEqual(7)
      seen.profiles += p.body.profiles.length
      for (const e of p.body.events) { expect(seen.events.has(e.id)).toBe(false); seen.events.add(e.id) }
      for (const l of p.body.list) { expect(seen.list.has(l.itemId)).toBe(false); seen.list.add(l.itemId) }
      expect(Number(p.body.cursor)).toBeGreaterThanOrEqual(Number(cursor))
      cursor = p.body.cursor
      if (!p.body.more) break
    }
    expect(seen.profiles).toBe(1)
    expect(seen.events.size).toBe(40)
    expect(seen.list.size).toBe(25)
    expect(pages).toBe(10) // 66 rows, 7 per page
  })

  it('rejects a cursor from the future', async () => {
    const u = await member()
    const r = await pull(u, '999999')
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('cursor_ahead')
  })

  it('needs a session', async () => {
    expect((await call('POST', '/v1/sync/push', { body: {} })).status).toBe(401)
    expect((await call('GET', '/v1/sync/pull')).status).toBe(401)
  })
})

describe('last write wins', () => {
  const rating = (pid: string, value: number, updatedAt: number) => ({ profileId: pid, itemId: 'tt0133093', itemType: 'movie', value, source: null, updatedAt })

  it('keeps the newest row whatever order devices push in, and ties keep the server copy', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    await push(u, { profiles: [profile({ id: pid })] })
    // Device A rated at t+200; device B (offline) rated at t+100 and pushes later.
    expect((await push(u, { ratings: [rating(pid, 1, T0 + 200)] })).body.applied.ratings).toBe(1)
    expect((await push(u, { ratings: [rating(pid, -1, T0 + 100)] })).body.applied.ratings).toBe(0)
    expect((await push(u, { ratings: [rating(pid, -1, T0 + 200)] })).body.applied.ratings).toBe(0) // tie
    expect((await pull(u)).body.ratings).toEqual([rating(pid, 1, T0 + 200)])
    // A newer clear (tombstone, value 0) wins and is pulled like any other change.
    const c = (await pull(u)).body.cursor
    expect((await push(u, { ratings: [rating(pid, 0, T0 + 300)] })).body.applied.ratings).toBe(1)
    expect((await pull(u, c)).body.ratings).toEqual([rating(pid, 0, T0 + 300)])
  })

  it('applies to My List, dismissals and prefs, with tombstones', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    const listRow = (inList: number, updatedAt: number) => ({ profileId: pid, itemId: 'tt0816692', itemType: 'movie', inList, addedAt: T0, updatedAt })
    const dis = (reason: string | null, updatedAt: number) => ({ profileId: pid, itemId: 'tt0816692', itemType: 'movie', reason, updatedAt })
    const pref = (value: number, updatedAt: number) => ({ profileId: pid, feature: 'g:Drama', value, updatedAt })
    await push(u, { profiles: [profile({ id: pid })], list: [listRow(1, T0 + 10)], dismissals: [dis('not_interested', T0 + 10)], prefs: [pref(1, T0 + 10)] })
    await push(u, { list: [listRow(0, T0 + 20)], dismissals: [dis(null, T0 + 20)], prefs: [pref(0, T0 + 5)] })
    const p = (await pull(u)).body
    expect(p.list).toEqual([listRow(0, T0 + 20)])
    expect(p.dismissals).toEqual([dis(null, T0 + 20)])
    expect(p.prefs).toEqual([pref(1, T0 + 10)])
  })

  it('progress: the newest row wins, but completion and the furthest counters survive across devices', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    await push(u, { profiles: [profile({ id: pid })] })
    // Device A finishes the film at t+5000.
    const finished = progressRow(pid, { position: 8100, maxPosition: 8100, watchedSec: 7000, completedAt: T0 + 5000, updatedAt: T0 + 5000 })
    await push(u, { progress: [finished] })
    // Device B, which never saw that, sends a later ping from the same viewing (started before completion).
    const ping = progressRow(pid, { position: 900, maxPosition: 900, watchedSec: 900, completedAt: null, updatedAt: T0 + 6000 })
    expect((await push(u, { progress: [ping] })).body.applied.progress).toBe(1)
    let row = (await pull(u)).body.progress[0]
    // Position follows the newest row; the monotonic counters and completion keep the furthest values.
    expect(row).toMatchObject({ position: 900, updatedAt: T0 + 6000, completedAt: T0 + 5000, maxPosition: 8100, watchedSec: 7000 })

    // The other order: B's later ping lands first, then A's older completed row arrives.
    const u2 = await member()
    const pid2 = crypto.randomUUID()
    await push(u2, { profiles: [profile({ id: pid2 })], progress: [progressRow(pid2, { position: 900, maxPosition: 900, watchedSec: 900, updatedAt: T0 + 6000 })] })
    const c = (await pull(u2)).body.cursor
    const older = progressRow(pid2, { position: 8100, maxPosition: 8100, watchedSec: 7000, completedAt: T0 + 5000, updatedAt: T0 + 5000 })
    expect((await push(u2, { progress: [older] })).body.applied.progress).toBe(1)
    const p = await pull(u2, c)
    expect(p.body.progress).toHaveLength(1)
    row = p.body.progress[0]
    expect(row).toMatchObject({ position: 900, updatedAt: T0 + 6000, completedAt: T0 + 5000, maxPosition: 8100, watchedSec: 7000 })
    // Re-pushing that older row, or an older one with nothing to add, changes nothing and moves no cursor.
    const c2 = (await pull(u2)).body.cursor
    expect((await push(u2, { progress: [older] })).body.applied.progress).toBe(0)
    expect((await push(u2, { progress: [progressRow(pid2, { position: 100, maxPosition: 100, watchedSec: 100, updatedAt: T0 + 2000 })] })).body.applied.progress).toBe(0)
    expect((await pull(u2, c2)).body.progress).toEqual([])
  })

  it('progress: "forget" is a newer tombstone and drops completion; a fresh viewing starts clean, counters too', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    await push(u, { profiles: [profile({ id: pid })], progress: [progressRow(pid, { completedAt: T0 + 5000, updatedAt: T0 + 5000 })] })
    await push(u, { progress: [progressRow(pid, { forgotten: 1, completedAt: null, updatedAt: T0 + 7000 })] })
    expect((await pull(u)).body.progress[0]).toMatchObject({ forgotten: 1, completedAt: null })
    // A stale completed row can't resurrect a forgotten one.
    await push(u, { progress: [progressRow(pid, { completedAt: T0 + 5000, updatedAt: T0 + 5000 })] })
    expect((await pull(u)).body.progress[0]).toMatchObject({ forgotten: 1, completedAt: null })
    // Watching again later starts a new viewing with no completion.
    await push(u, { progress: [progressRow(pid, { startedAt: T0 + 8000, position: 60, maxPosition: 60, watchedSec: 30, completedAt: null, updatedAt: T0 + 8000 })] })
    expect((await pull(u)).body.progress[0]).toMatchObject({ forgotten: 0, completedAt: null, position: 60, maxPosition: 60, watchedSec: 30 })
  })

  it('profiles: newest name wins; deletion is sticky even when it is older', async () => {
    const u = await member()
    const pid = crypto.randomUUID()
    await push(u, { profiles: [profile({ id: pid, name: 'Kids', updatedAt: T0 + 10 })] })
    await push(u, { profiles: [profile({ id: pid, name: 'Old name', updatedAt: T0 + 5 })] })
    expect((await pull(u)).body.profiles[0].name).toBe('Kids')
    await push(u, { profiles: [profile({ id: pid, name: 'Children', updatedAt: T0 + 20 })] })
    // Another device deleted it at t+15, before that rename reached it.
    const r = await push(u, { profiles: [profile({ id: pid, name: 'Kids', updatedAt: T0 + 15, deletedAt: T0 + 15 })] })
    expect(r.body.applied.profiles).toBe(1)
    expect((await pull(u)).body.profiles[0]).toMatchObject({ name: 'Children', updatedAt: T0 + 20, deletedAt: T0 + 15 })
  })
})

describe('account isolation', () => {
  it("one account can't read or write another's data", async () => {
    const a = await member()
    const b = await member()
    const pidA = crypto.randomUUID()
    await push(a, fullBatch(pidA))
    const before = (await pull(a)).body

    const bView = await pull(b)
    for (const s of ['profiles', 'events', 'ratings', 'list', 'progress', 'dismissals', 'prefs']) expect(bView.body[s], s).toEqual([])

    // B can't claim A's profile id, nor write rows under it.
    const claim = await push(b, { profiles: [profile({ id: pidA, name: 'Mine now', updatedAt: T0 + 99_999 })] })
    expect(claim.status).toBe(409)
    expect(claim.body.error).toBe('profile_conflict')
    const write = await push(b, { ratings: [{ profileId: pidA, itemId: 'tt0133093', itemType: 'movie', value: -1, source: null, updatedAt: T0 + 99_999 }] })
    expect(write.status).toBe(409)
    // Re-sending A's event ids under B's own profile only creates B's copies.
    const pidB = crypto.randomUUID()
    const events = before.events.map((e: Record<string, unknown>) => ({ ...e, profileId: pidB }))
    expect((await push(b, { profiles: [profile({ id: pidB })], events })).body.applied.events).toBe(5)

    expect((await pull(a)).body).toMatchObject({ profiles: before.profiles, events: before.events, ratings: before.ratings, progress: before.progress })
    const bAfter = (await pull(b)).body
    expect(bAfter.profiles.map((p: { id: string }) => p.id)).toEqual([pidB])
    expect(bAfter.events.every((e: { profileId: string }) => e.profileId === pidB)).toBe(true)
  })

  it('rows must name a profile on this account', async () => {
    const u = await member()
    const r = await push(u, { ratings: [{ profileId: crypto.randomUUID(), itemId: 'tt0133093', itemType: 'movie', value: 1, source: null, updatedAt: T0 }] })
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('unknown_profile')
  })

  it('a disabled account can no longer sync', async () => {
    const u = await member()
    await call('POST', `/v1/admin/accounts/${u.id}/disable`, { token: admin.token })
    expect((await pull(u)).status).toBe(401)
  })
})

describe('payload validation', () => {
  let u: User
  let pid: string
  beforeAll(async () => {
    u = await member()
    pid = crypto.randomUUID()
    await push(u, { profiles: [profile({ id: pid })] })
  })

  const rating = (over: Record<string, unknown>) => ({ ratings: [{ profileId: pid, itemId: 'tt0133093', itemType: 'movie', value: 1, source: null, updatedAt: T0, ...over }] })
  const event = (over: Record<string, unknown>) => ({ events: [{ id: crypto.randomUUID(), profileId: pid, kind: 'play', itemId: 'tt0133093', itemType: 'movie', value: 0.5, context: { streamId: 'tt0133093', position: 1, duration: 2, watchedSec: 1 }, at: T0, ...over }] })
  const HASH = 'c9e15763f722f23e98a29decdfae341b98d53056'

  const cases: Array<[string, () => unknown]> = [
    ['non-IMDb item id', () => rating({ itemId: '12345' })],
    ['an info hash as item id', () => rating({ itemId: HASH })],
    ['unknown field on a row', () => rating({ infoHash: HASH })],
    ['unknown top-level section', () => ({ torrents: [] })],
    ['bad item type', () => rating({ itemType: 'torrent' })],
    ['rating out of range', () => rating({ value: 2 })],
    ['free-form rating source', () => rating({ source: 'Some Release Group [1080p]' })],
    ['timestamp an hour+ in the future', () => rating({ updatedAt: Date.now() + 2 * 3600_000 })],
    ['timestamp before 2020', () => rating({ updatedAt: 1000 })],
    ['float timestamp', () => rating({ updatedAt: T0 + 0.5 })],
    ['non-UUID profile id', () => rating({ profileId: 'me' })],
    ['free-form event context key', () => event({ context: { streamId: 'tt0133093', infoHash: HASH } })],
    ['file name smuggled in context', () => event({ context: { streamId: 'tt0133093', fileName: 'Movie.2010.1080p.mkv' } })],
    ['context key not allowed for the kind', () => event({ kind: 'rating', value: 1, context: { streamId: 'tt0133093' } })],
    ['context as a string blob', () => event({ context: JSON.stringify({ infoHash: HASH }) })],
    ['streamId of another title', () => event({ context: { streamId: 'tt0000001' } })],
    ['streamId with a hash', () => event({ context: { streamId: `tt0133093:${HASH}` } })],
    ['unknown event kind', () => event({ kind: 'download' })],
    ['play value above 1', () => event({ value: 3 })],
    ['pref with an item id', () => event({ kind: 'pref', value: 1, context: { feature: 'g:Drama' } })],
    ['pref without a feature', () => event({ kind: 'pref', itemId: null, itemType: null, value: 1, context: null })],
    ['feature key of unknown kind', () => ({ prefs: [{ profileId: pid, feature: 'x:anything', value: 1, updatedAt: T0 }] })],
    ['info hash inside a feature key', () => ({ prefs: [{ profileId: pid, feature: `d:${HASH}`, value: 1, updatedAt: T0 }] })],
    ['magnet link as profile name', () => ({ profiles: [profile({ name: `magnet:?xt=urn:btih:${HASH}` })] })],
    ['info hash as avatar', () => ({ profiles: [profile({ avatar: HASH })] })],
    ['base32 info hash in a name', () => ({ profiles: [profile({ name: 'ZHVMHTZQ6IXKLMOFNQXU2VQVL4YFWM3T' })] })],
    ['file name as profile name', () => ({ profiles: [profile({ name: 'Inception.2010.mkv' })] })],
    ['control characters in a name', () => ({ profiles: [profile({ name: 'a\u0000b' })] })],
    ['series progress without an episode', () => ({ progress: [progressRow(pid, { itemId: 'tt0903747', itemType: 'series', streamId: 'tt0903747' })] })],
    ['movie progress with an episode', () => ({ progress: [progressRow(pid, { streamId: 'tt0133093:1:1', season: 1, episode: 1 })] })],
    ['season not matching streamId', () => ({ progress: [progressRow(pid, { itemId: 'tt0903747', itemType: 'series', streamId: 'tt0903747:1:2', season: 2, episode: 2 })] })],
    ['negative position', () => ({ progress: [progressRow(pid, { position: -1 })] })],
    ['zero duration', () => ({ progress: [progressRow(pid, { duration: 0 })] })],
    ['boolean instead of 0/1', () => ({ progress: [progressRow(pid, { hidden: true })] })],
    ['missing field', () => ({ list: [{ profileId: pid, itemId: 'tt1', itemType: 'movie', inList: 1, updatedAt: T0 }] })],
    ['section not an array', () => ({ ratings: { a: 1 } })],
  ]

  it.each(cases)('rejects %s', async (_name, make) => {
    const r = await push(u, make())
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toBe('invalid')
    expect(r.body.message).toMatch(/\S/)
  })

  it('names the offending field', async () => {
    const r = await push(u, { ratings: [rating({}).ratings[0], rating({ itemId: 'bad' }).ratings[0]] })
    expect(r.body.message).toMatch(/^ratings\[1\]\.itemId:/)
  })

  it('a rejected push stores nothing', async () => {
    const before = (await pull(u)).body.cursor
    await push(u, { ...rating({ itemId: 'tt42' }), ...event({ kind: 'nope' }) })
    expect((await pull(u)).body.cursor).toBe(before)
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM ratings WHERE item_id = 'tt42'").first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  it('limits batch size and body size', async () => {
    const many = Array.from({ length: LIMITS.pushItems + 1 }, (_, i) => rating({ itemId: `tt${i + 1}` }).ratings[0])
    const r = await push(u, { ratings: many })
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('too_many_items')
    const big = await call('POST', '/v1/sync/push', { token: u.token, raw: JSON.stringify({ ratings: [] }) + ' '.repeat(LIMITS.pushBytes) })
    expect(big.status).toBe(413)
    expect(big.body.error).toBe('too_large')
  })

  it('accepts exactly the limit', async () => {
    const rows = Array.from({ length: LIMITS.pushItems }, (_, i) => rating({ itemId: `tt${i + 1}` }).ratings[0])
    const r = await push(u, { ratings: rows })
    expect(r.status).toBe(200)
    expect(r.body.applied.ratings).toBe(LIMITS.pushItems)
  })

  it('validates pull parameters', async () => {
    expect((await call('GET', '/v1/sync/pull?since=abc', { token: u.token })).status).toBe(400)
    expect((await call('GET', '/v1/sync/pull?since=0&limit=5000', { token: u.token })).status).toBe(400)
    expect((await call('GET', '/v1/sync/pull?since=0&hash=1', { token: u.token })).status).toBe(400)
    expect((await call('POST', '/v1/sync/push', { token: u.token, raw: 'not json' })).status).toBe(400)
    expect((await call('POST', '/v1/sync/push', { token: u.token, raw: '[]' })).status).toBe(400)
  })
})
