import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, SCHEMA_VERSION, UUID } from './db.ts'
import { SqliteTasteStore } from './store.ts'

const MOVIE = { id: 'tt0112471', type: 'movie' as const }
const SERIES = { id: 'tt0903747', type: 'series' as const }

let dir: string
let db: DatabaseSync
let clock: number
let store: SqliteTasteStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexttupp-store-'))
  db = openDb(join(dir, 'nexttupp.db'))
  clock = Date.UTC(2026, 0, 1)
  store = new SqliteTasteStore(db, { now: () => clock })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const rows = (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>

describe('schema', () => {
  it('migrates a new database to the latest version in WAL mode, and reopening is a no-op', () => {
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name)
    for (const t of ['profiles', 'events', 'ratings', 'my_list', 'progress', 'dismissals', 'feature_prefs', 'items', 'sync_state']) expect(tables).toContain(t)
    store.defaultProfile()
    db.close()
    db = openDb(join(dir, 'nexttupp.db'))
    expect(new SqliteTasteStore(db).listProfiles()).toHaveLength(1)
  })

  it('has no autoincrement keys and an updated_at on every synced state table', () => {
    // sync_outbox is LOCAL bookkeeping and needs ids that are never reused; nothing else may autoincrement.
    const sql = rows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sync_outbox', 'sqlite_sequence')").map(r => String(r.sql)).join('\n')
    expect(sql).not.toMatch(/AUTOINCREMENT/i)
    for (const t of ['profiles', 'ratings', 'my_list', 'progress', 'dismissals', 'feature_prefs']) {
      expect(rows(`PRAGMA table_info(${t})`).map(c => c.name)).toContain('updated_at')
    }
    expect(rows('PRAGMA table_info(profiles)').map(c => c.name)).toContain('account_id')
  })
})

describe('profiles', () => {
  it('auto-creates "Me" once, with a UUIDv7 id', () => {
    const me = store.defaultProfile()
    expect(me.name).toBe('Me')
    expect(me.id).toMatch(UUID)
    expect(me.id[14]).toBe('7')
    expect(store.defaultProfile().id).toBe(me.id)
  })

  it('creates, renames and deletes (as a tombstone)', () => {
    const me = store.defaultProfile()
    clock += 1
    const kid = store.createProfile({ name: 'Kid', avatar: 'blue' })
    expect(store.listProfiles().map(p => p.name)).toEqual(['Me', 'Kid'])
    expect(store.updateProfile(kid.id, { name: 'Sam', avatar: null })).toMatchObject({ name: 'Sam', avatar: undefined })
    expect(store.deleteProfile(kid.id)).toBe(true)
    expect(store.getProfile(kid.id)).toBeNull()
    expect(store.listProfiles().map(p => p.id)).toEqual([me.id])
    expect(rows('SELECT deleted_at FROM profiles WHERE id = ?', kid.id)[0].deleted_at).toBe(clock)
  })

  it('keeps profiles apart', () => {
    const a = store.createProfile({ name: 'A' })
    const b = store.createProfile({ name: 'B' })
    store.setRating(a.id, MOVIE, 1)
    store.setInList(a.id, SERIES, true)
    expect(store.snapshot(b.id).ratings).toHaveLength(0)
    expect(store.titleState(b.id, MOVIE).rating).toBe(0)
    expect(store.snapshot(a.id).list.map(l => l.id)).toEqual([SERIES.id])
  })
})

describe('taste state', () => {
  it('logs every change as an immutable event with a unique id', () => {
    const p = store.defaultProfile()
    store.setRating(p.id, MOVIE, 1, 'title')
    clock += 1000
    store.setRating(p.id, MOVIE, 0)
    const events = store.events(p.id)
    expect(events.map(e => [e.kind, e.value])).toEqual([['rating', 1], ['rating', 0]])
    expect(new Set(events.map(e => e.id)).size).toBe(2)
    expect(events[0].context).toEqual({ source: 'title' })
  })

  it('clears a rating as a 0 row (a tombstone that syncs), not a delete', () => {
    const p = store.defaultProfile()
    store.setRating(p.id, MOVIE, -1)
    clock += 5000
    store.setRating(p.id, MOVIE, 0)
    expect(rows('SELECT value, updated_at FROM ratings WHERE profile_id = ?', p.id)).toEqual([{ value: 0, updated_at: clock }])
    expect(store.snapshot(p.id).ratings).toHaveLength(0)
    expect(store.titleState(p.id, MOVIE).rating).toBe(0)
  })

  it('removes from My List with a tombstone and remembers when it was re-added', () => {
    const p = store.defaultProfile()
    store.setInList(p.id, MOVIE, true)
    clock += 1000
    store.setInList(p.id, MOVIE, false)
    expect(rows('SELECT in_list FROM my_list')).toEqual([{ in_list: 0 }])
    expect(store.titleState(p.id, MOVIE).inList).toBe(false)
    clock += 1000
    store.setInList(p.id, MOVIE, true)
    expect(store.snapshot(p.id).list[0].addedAt).toBe(clock)
  })

  it('a dislike or "not interested" takes the title off My List', () => {
    const p = store.defaultProfile()
    store.setInList(p.id, MOVIE, true)
    store.setRating(p.id, MOVIE, -1)
    expect(store.titleState(p.id, MOVIE).inList).toBe(false)
    store.setInList(p.id, SERIES, true)
    store.dismiss(p.id, SERIES, 'not_interested')
    expect(store.titleState(p.id, SERIES)).toMatchObject({ inList: false, dismissed: 'not_interested' })
    store.dismiss(p.id, SERIES, null)
    expect(store.titleState(p.id, SERIES).dismissed).toBeNull()
    expect(rows('SELECT reason FROM dismissals WHERE item_id = ?', SERIES.id)).toEqual([{ reason: null }])
  })
})

describe('progress', () => {
  const ping = (p: string, position: number, duration = 6000, ref: { id: string; type: 'movie' | 'series' } = MOVIE, streamId = ref.id) =>
    store.recordProgress(p, { ...ref, streamId, position, duration })

  it('counts real playback, not seeks, and completes only after real watching', () => {
    const p = store.defaultProfile().id
    ping(p, 0)
    for (let t = 10; t <= 600; t += 10) { clock += 10_000; ping(p, t) }
    expect(store.snapshot(p).progress[0].watchedSec).toBeCloseTo(600, 0)
    clock += 10_000
    // Jump to the credits: position moves, watched time doesn't, so it isn't "finished".
    const skipped = ping(p, 5900)
    expect(store.snapshot(p).progress[0].watchedSec).toBeLessThan(620)
    expect(skipped.completed).toBe(false)
  })

  it('marks a title complete when it reaches the end after enough real playback, and logs milestones', () => {
    const p = store.defaultProfile().id
    const duration = 1200
    for (let t = 0; t <= 1150; t += 10) { ping(p, t, duration); clock += 10_000 }
    const state = store.titleState(p, MOVIE)
    expect(state.progress).toMatchObject({ completed: true, streamId: MOVIE.id })
    const kinds = store.events(p).map(e => e.kind)
    expect(kinds.filter(k => k === 'play')).toHaveLength(1)
    expect(kinds.filter(k => k === 'progress')).toHaveLength(3)
    expect(kinds.filter(k => k === 'complete')).toHaveLength(1)
    expect(kinds.length).toBeLessThan(10)
  })

  it('keeps per-episode progress for series and reports the latest episode', () => {
    const p = store.defaultProfile().id
    ping(p, 100, 3000, SERIES, `${SERIES.id}:1:2`)
    clock += 60_000
    ping(p, 50, 3000, SERIES, `${SERIES.id}:1:1`)
    const state = store.titleState(p, SERIES)
    expect(state.progress?.streamId).toBe(`${SERIES.id}:1:1`)
    expect(state.episodes?.map(e => e.episode)).toEqual([1, 2])
  })

  it('hides from Continue watching or forgets entirely', () => {
    const p = store.defaultProfile().id
    ping(p, 100)
    store.clearProgress(p, MOVIE, 'hide')
    expect(store.snapshot(p).progress[0].hidden).toBe(true)
    expect(store.titleState(p, MOVIE).progress).not.toBeNull()
    store.clearProgress(p, MOVIE, 'forget')
    expect(store.snapshot(p).progress).toHaveLength(0)
    expect(store.titleState(p, MOVIE).progress).toBeNull()
    // Playing it again starts afresh.
    clock += 10_000
    expect(ping(p, 30).position).toBe(30)
    expect(store.snapshot(p).progress[0].watchedSec).toBe(0)
  })

  it('never stores torrent details in taste tables or events', () => {
    const p = store.defaultProfile().id
    ping(p, 10)
    clock += 10_000
    ping(p, 20)
    store.setRating(p, MOVIE, 1, 'player')
    store.dismiss(p, SERIES, 'seen')
    const allowed = new Set(['streamId', 'position', 'duration', 'watchedSec', 'source', 'reason', 'feature'])
    for (const e of store.events(p)) for (const k of Object.keys(e.context ?? {})) expect(allowed).toContain(k)
    const cols = ['events', 'ratings', 'my_list', 'progress', 'dismissals'].flatMap(t => rows(`PRAGMA table_info(${t})`).map(c => String(c.name)))
    expect(cols.filter(c => /hash|^file|file_?name|source_name|tracker|magnet/i.test(c))).toEqual([])
  })
})

describe('impressions', () => {
  it('counts a title at most once per window', () => {
    const p = store.defaultProfile().id
    store.recordImpressions(p, ['tt1', 'tt2'])
    clock += 10 * 60_000
    store.recordImpressions(p, ['tt1'])
    expect(store.impressions(p).get('tt1')?.count).toBe(1)
    clock += 60 * 60_000
    store.recordImpressions(p, ['tt1'])
    expect(store.impressions(p).get('tt1')?.count).toBe(2)
    expect(store.impressions(p).get('tt2')?.count).toBe(1)
  })
})

describe('change notifications', () => {
  it('notifies on taste changes but not on every progress ping', () => {
    const p = store.defaultProfile().id
    const seen: string[] = []
    store.onChange(id => seen.push(id))
    store.setRating(p, MOVIE, 1)
    store.recordProgress(p, { ...MOVIE, streamId: MOVIE.id, position: 10, duration: 6000 })
    clock += 10_000
    store.recordProgress(p, { ...MOVIE, streamId: MOVIE.id, position: 20, duration: 6000 })
    expect(seen).toEqual([p, p])
  })

  it('notifies once when a title qualifies for Continue watching, so a cached Home picks it up', () => {
    const p = store.defaultProfile().id
    const seen: number[] = []
    store.onChange(() => seen.push(clock))
    const start = clock
    store.recordProgress(p, { ...MOVIE, streamId: MOVIE.id, position: 0, duration: 6000 })
    for (let t = 10; t <= 200; t += 10) {
      clock += 10_000
      store.recordProgress(p, { ...MOVIE, streamId: MOVIE.id, position: t, duration: 6000 })
    }
    // The first ping, then the one where real playback reaches two minutes; nothing for the pings between.
    expect(seen.map(at => (at - start) / 1000)).toEqual([0, 120])
  })
})
