import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBatch } from '../../cloud/src/wire.ts'
import { openDb, uuidv7 } from '../db.ts'
import { SqliteTasteStore } from '../store.ts'
import { ackPush, applyPull, collectPush, emptyBatch, linkProfiles, pendingCount } from './local.ts'

const MOVIE = { id: 'tt0112471', type: 'movie' as const }
const OTHER = { id: 'tt0133093', type: 'movie' as const }
const SERIES = { id: 'tt0903747', type: 'series' as const }
const ACCOUNT = '11111111-1111-4111-8111-111111111111'

let clock: number
let a: { db: DatabaseSync; store: SqliteTasteStore }
let b: { db: DatabaseSync; store: SqliteTasteStore }

const device = () => {
  const db = openDb(':memory:')
  return { db, store: new SqliteTasteStore(db, { now: () => clock }) }
}
const outbox = (db: DatabaseSync) => db.prepare('SELECT tbl, k1, k2 FROM sync_outbox ORDER BY id').all() as Array<{ tbl: string; k1: string; k2: string }>
const one = (db: DatabaseSync, sql: string, ...p: string[]) => db.prepare(sql).get(...p) as Record<string, unknown> | undefined

/** Pushes everything A has, as the cloud would store it, and pulls it into B. */
function relay (from: DatabaseSync, to: DatabaseSync) {
  const all = emptyBatch()
  for (let out = collectPush(from, ACCOUNT, clock); out; out = collectPush(from, ACCOUNT, clock)) {
    parseBatch(out.batch as unknown as Record<string, unknown>, clock) // the cloud's own validator accepts it
    for (const k of Object.keys(all) as Array<keyof typeof all>) (all[k] as unknown[]).push(...out.batch[k])
    ackPush(from, out.ids)
  }
  return { batch: all, changed: applyPull(to, ACCOUNT, all) }
}

beforeEach(() => {
  clock = Date.UTC(2026, 9, 1)
  a = device()
  b = device()
})
afterEach(() => { a.db.close(); b.db.close() })

describe('outbox', () => {
  it('queues every synced write once per key, and a push clears only the versions it sent', () => {
    const p = a.store.defaultProfile()
    a.store.setRating(p.id, MOVIE, 1, 'title')
    a.store.setRating(p.id, MOVIE, -1, 'title')
    a.store.setInList(p.id, OTHER, true)
    a.store.recordImpressions(p.id, [MOVIE.id]) // LOCAL: never queued
    const keys = outbox(a.db).filter(e => e.tbl !== 'events')
    expect(keys).toEqual(expect.arrayContaining([
      { tbl: 'profiles', k1: p.id, k2: '' },
      { tbl: 'ratings', k1: p.id, k2: MOVIE.id },
      { tbl: 'my_list', k1: p.id, k2: OTHER.id },
    ]))
    expect(keys.filter(e => e.tbl === 'ratings')).toHaveLength(1)
    expect(outbox(a.db).some(e => e.tbl === 'impressions')).toBe(false)

    a.db.prepare('UPDATE profiles SET account_id = ?').run(ACCOUNT)
    const out = collectPush(a.db, ACCOUNT, clock)!
    // Written again while the push is in flight: that newer version must survive the ack.
    clock += 1000
    a.store.setRating(p.id, MOVIE, 1, 'title')
    ackPush(a.db, out.ids)
    expect(outbox(a.db).filter(e => e.tbl !== 'events')).toEqual([{ tbl: 'ratings', k1: p.id, k2: MOVIE.id }])
  })

  it('builds batches the cloud accepts, with nothing that identifies a file or a torrent', () => {
    const p = a.store.defaultProfile()
    a.store.setRating(p.id, MOVIE, 1, 'Some Free Text')
    a.store.setInList(p.id, SERIES, true)
    a.store.recordProgress(p.id, { ...SERIES, streamId: `${SERIES.id}:1:2`, position: 600, duration: 2800 })
    a.store.dismiss(p.id, OTHER, 'seen')
    a.store.setFeaturePref(p.id, 'd:christopher nolan', 1)
    a.store.clearProgress(p.id, SERIES, 'hide')
    linkProfiles(a.db, ACCOUNT, clock)
    const out = collectPush(a.db, ACCOUNT, clock)!
    const batch = parseBatch(out.batch as unknown as Record<string, unknown>, clock)
    expect(batch.profiles.map(x => x.id)).toEqual([p.id])
    expect(batch.ratings[0]).toMatchObject({ itemId: MOVIE.id, value: 1, source: null }) // free text isn't a plain word
    expect(batch.events.find(e => e.kind === 'pref')).toMatchObject({ itemId: null, itemType: null, context: { feature: 'd:christopher nolan' } })
    expect(batch.events.find(e => e.kind === 'rating')!.context).toBeNull()
    expect(batch.progress[0]).toMatchObject({ streamId: `${SERIES.id}:1:2`, season: 1, episode: 2, hidden: 1 })
    expect(JSON.stringify(out.batch)).not.toMatch(/infoHash|magnet|fileName|\.mkv|\.mp4/i)
  })

  it('caps a push at the row limit and sends each row’s profile with it', () => {
    const p = a.store.defaultProfile()
    for (let i = 0; i < 30; i++) a.store.setRating(p.id, { id: `tt${1000000 + i}`, type: 'movie' }, 1)
    linkProfiles(a.db, ACCOUNT, clock)
    const first = collectPush(a.db, ACCOUNT, clock, { maxRows: 10 })!
    expect(Object.values(first.batch).flat()).toHaveLength(10)
    expect(first.batch.profiles).toHaveLength(1)
    ackPush(a.db, first.ids)
    const second = collectPush(a.db, ACCOUNT, clock, { maxRows: 10 })!
    expect(second.batch.profiles).toHaveLength(1)
    expect(second.batch.ratings.length + second.batch.events.length).toBe(9)
  })

  it('skips profiles deleted before they were ever synced, and leaves another account’s rows queued', () => {
    const keep = a.store.defaultProfile()
    const gone = a.store.createProfile({ name: 'e2e throwaway' })
    a.store.setRating(gone.id, MOVIE, 1)
    a.store.deleteProfile(gone.id)
    const theirs = a.store.createProfile({ name: 'Theirs' })
    a.store.setRating(theirs.id, MOVIE, -1)
    a.db.prepare('UPDATE profiles SET account_id = ? WHERE id = ?').run('22222222-2222-4222-8222-222222222222', theirs.id)
    linkProfiles(a.db, ACCOUNT, clock)

    const out = collectPush(a.db, ACCOUNT, clock)!
    expect(out.batch.profiles.map(x => x.id)).toEqual([keep.id])
    expect(out.batch.ratings).toHaveLength(0)
    ackPush(a.db, out.ids)
    expect(collectPush(a.db, ACCOUNT, clock)).toBeNull()
    // The other account's entries wait for that account; the throwaway's are gone.
    expect(outbox(a.db).every(e => e.k1 === theirs.id || one(a.db, 'SELECT profile_id FROM events WHERE id = ?', e.k1)?.profile_id === theirs.id)).toBe(true)
    expect(pendingCount(a.db)).toBeGreaterThan(0)
  })
})

describe('applying a pull', () => {
  it('carries likes, My List and progress from one device to another, without queueing them back', () => {
    const p = a.store.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    a.store.setRating(p.id, MOVIE, 1, 'title')
    a.store.setInList(p.id, OTHER, true)
    a.store.recordProgress(p.id, { ...MOVIE, streamId: MOVIE.id, position: 900, duration: 5400 })
    const { changed } = relay(a.db, b.db)
    expect([...changed]).toEqual([p.id])
    expect(b.store.listProfiles().map(x => x.name)).toEqual(['Me'])
    expect(b.store.titleState(p.id, MOVIE)).toMatchObject({ rating: 1, progress: { position: 900 } })
    expect(b.store.titleState(p.id, OTHER).inList).toBe(true)
    expect(b.store.events(p.id).length).toBe(a.store.events(p.id).length)
    expect(outbox(b.db)).toEqual([])
    expect(one(b.db, 'SELECT account_id FROM profiles WHERE id = ?', p.id)!.account_id).toBe(ACCOUNT)
    // Applying the same page again changes nothing.
    expect(applyPull(b.db, ACCOUNT, relay(a.db, b.db).batch).size).toBe(0)
  })

  it('last write wins on updatedAt, ties go to the pulled row, and removals arrive as tombstones', () => {
    const p = a.store.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    a.store.setRating(p.id, MOVIE, 1)
    a.store.setInList(p.id, MOVIE, true)
    relay(a.db, b.db)

    // B changes its mind later; an older change from A must not undo it.
    clock += 60_000
    b.store.setRating(p.id, MOVIE, -1)
    const stale = { ...emptyBatch(), ratings: [{ profileId: p.id, itemId: MOVIE.id, itemType: 'movie' as const, value: 1 as const, source: null, updatedAt: clock - 30_000 }] }
    applyPull(b.db, ACCOUNT, stale)
    expect(b.store.titleState(p.id, MOVIE).rating).toBe(-1)

    // A removes it from My List: the tombstone (inList 0) reaches B.
    clock += 60_000
    a.store.setInList(p.id, MOVIE, false)
    a.store.setRating(p.id, OTHER, 0)
    relay(a.db, b.db)
    expect(b.store.titleState(p.id, MOVIE).inList).toBe(false)
    expect(one(b.db, 'SELECT in_list FROM my_list WHERE item_id = ?', MOVIE.id)!.in_list).toBe(0)
  })

  it('a profile deleted anywhere stays deleted', () => {
    const p = a.store.defaultProfile()
    const kid = a.store.createProfile({ name: 'Kid' })
    linkProfiles(a.db, ACCOUNT, clock)
    relay(a.db, b.db)
    expect(b.store.listProfiles()).toHaveLength(2)

    clock += 1000
    b.store.deleteProfile(kid.id)
    // A renames it afterwards, not knowing: the rename doesn't bring it back on B.
    clock += 1000
    a.store.updateProfile(kid.id, { name: 'Kiddo' })
    relay(a.db, b.db)
    expect(b.store.getProfile(kid.id)).toBeNull()
    // And B's tombstone reaches A.
    relay(b.db, a.db)
    expect(a.store.listProfiles().map(x => x.id)).toEqual([p.id])
  })
})

describe('signing in on a second computer', () => {
  it('merges a profile with the same name into the account’s, newer row winning, and adds the others', () => {
    const me = a.store.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    a.store.setRating(me.id, MOVIE, 1)
    a.store.setInList(me.id, OTHER, true)
    relay(a.db, b.db) // B pulls the account first, as the service does

    // B had its own "Me" (and a guest) before signing in.
    const local = b.db.prepare("INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at) VALUES (?, NULL, ' me ', NULL, ?, ?)")
    const bMe = uuidv7(clock)
    local.run(bMe, clock, clock)
    clock += 1000
    b.store.setRating(bMe, MOVIE, -1) // newer than A's like: wins
    b.store.setRating(bMe, SERIES, 1)
    const guest = b.store.createProfile({ name: 'Guest' })
    b.store.setInList(guest.id, MOVIE, true)

    const merged = linkProfiles(b.db, ACCOUNT, clock)
    expect(merged).toEqual({ [bMe]: me.id })
    expect(b.store.listProfiles().map(x => x.name).sort()).toEqual(['Guest', 'Me'])
    expect(b.store.titleState(me.id, MOVIE).rating).toBe(-1)
    expect(b.store.titleState(me.id, SERIES).rating).toBe(1)
    expect(b.store.titleState(me.id, OTHER).inList).toBe(true)
    expect(b.store.events(bMe)).toHaveLength(0)

    // What B pushes: its newer rows under the account's profile, and the guest. Never the retired twin.
    const pushed = relay(b.db, a.db).batch
    expect(pushed.profiles.map(x => x.id).sort()).toEqual([me.id, guest.id].sort())
    expect(pushed.ratings.map(r => [r.profileId, r.itemId, r.value]).sort()).toEqual([[me.id, MOVIE.id, -1], [me.id, SERIES.id, 1]].sort())
    expect(JSON.stringify(pushed)).not.toContain(bMe)
    expect(a.store.titleState(me.id, MOVIE).rating).toBe(-1)
    expect(a.store.listProfiles().map(x => x.name).sort()).toEqual(['Guest', 'Me'])
  })
})
