import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIMITS, parseBatch, parseMusicBatch, type MusicBatch } from '../../cloud/src/wire.ts'
import type { MusicTrack } from '../../shared/music.ts'
import { migrate, openDb, SCHEMA_VERSION, uuidv7 } from '../db.ts'
import { artistIdOf, trackIdOf } from '../music/catalog.ts'
import { MusicStore } from '../music/store.ts'
import { SqliteTasteStore } from '../store.ts'
import { ackPush, applyPull, collectPush, emptyBatch, linkProfiles, pendingCount } from './local.ts'
import { ackMusicPush, applyMusicPull, collectMusicPush, emptyMusicBatch, musicPendingCount, trackWire } from './music.ts'
import { SyncService } from './service.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const DZ = `https://cdn-images.dzcdn.net/images/artist/${'0123456789abcdef'.repeat(2)}/500x500-000000-80-0-0.jpg`
const IT = 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/aa/bb/cc/source/600x600bb.jpg'

const song = (artist: string, title: string, over: Partial<MusicTrack> = {}): MusicTrack => ({
  id: trackIdOf(artist, title),
  title,
  artist: { id: artistIdOf(artist), name: artist, picture: DZ },
  album: { id: 'it1630340270', title: `${title} (Original Soundtrack)`, cover: IT },
  duration: 240,
  rank: 0.5,
  ...over,
})
const KESARIYA = song('Arijit Singh', 'Kesariya', { credit: 'Pritam, Arijit Singh & Amitabh Bhattacharya' })
const BROWN = song('AP Dhillon', 'Brown Munde')
const EXCUSES = song('AP Dhillon', 'Excuses')

let clock: number
type Device = { db: DatabaseSync; taste: SqliteTasteStore; music: MusicStore }
let a: Device
let b: Device

const device = (db = openDb(':memory:')): Device => ({ db, taste: new SqliteTasteStore(db, { now: () => clock }), music: new MusicStore(db, () => clock) })
const musicOutbox = (db: DatabaseSync) => db.prepare('SELECT tbl, k1, k2 FROM sync_music_outbox ORDER BY id').all() as Array<{ tbl: string; k1: string; k2: string }>

/** A computer that already knows these songs and their artists (as browsing Music would leave it). */
function knows (d: Device, ...tracks: MusicTrack[]) {
  d.music.saveTracks(tracks)
  for (const t of tracks) d.music.put({ id: t.artist.id, name: t.artist.name, picture: t.artist.picture, deezer: '4495513', itunes: '587366' })
}

/** As the service does: the film push (profiles) first, then music; everything checked by the cloud's validators, then pulled into `to`. */
function relay (from: Device, to: Device): MusicBatch {
  for (let out = collectPush(from.db, ACCOUNT, clock); out; out = collectPush(from.db, ACCOUNT, clock)) {
    parseBatch(out.batch as unknown as Record<string, unknown>, clock)
    applyPull(to.db, ACCOUNT, out.batch)
    ackPush(from.db, out.ids)
  }
  const all = emptyMusicBatch()
  for (let out = collectMusicPush(from.db, ACCOUNT, clock); out; out = collectMusicPush(from.db, ACCOUNT, clock)) {
    parseMusicBatch(out.batch as unknown as Record<string, unknown>, clock)
    for (const k of Object.keys(all) as Array<keyof MusicBatch>) (all[k] as unknown[]).push(...out.batch[k])
    ackMusicPush(from.db, out.ids)
  }
  applyMusicPull(to.db, all, clock)
  return all
}

beforeEach(() => {
  clock = Date.UTC(2026, 9, 1)
  a = device()
  b = device()
})
afterEach(() => { a.db.close(); b.db.close() })

describe('migration 5', () => {
  it('queues music written before the upgrade (likes, then asked-for mixes, then listens), never engine mixes or downloads', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, 4)
    const d = device(db)
    const me = d.taste.defaultProfile()
    knows(d, KESARIYA, BROWN)
    d.music.rate(me.id, 'track', KESARIYA.id, 1)
    d.music.rate(me.id, 'artist', BROWN.artist.id, 0)
    d.music.listen(me.id, KESARIYA, 240, 'ended')
    d.music.listen(me.id, BROWN, 5, 'skipped')
    for (const kind of ['ai', 'mood', 'daily', 'artist'] as const) d.music.saveMix(me.id, { id: `m${kind.padEnd(15, '0').slice(0, 15).replace(/[^0-9a-f]/g, 'a')}`, kind, title: kind, subtitle: 'x', tracks: [{ id: KESARIYA.id }], at: clock })
    db.prepare("INSERT INTO music_files (track_id, kind, ref, bytes, used_at) VALUES (?, 'audio', 'dQw4w9WgXcQ', 1, ?)").run(KESARIYA.id, clock)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sync_music_outbox'").get()).toBeUndefined()

    migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect(musicOutbox(db).map(e => e.tbl)).toEqual(['music_ratings', 'music_ratings', 'music_mixes', 'music_mixes', 'music_listens', 'music_listens'])
    expect(musicOutbox(db).filter(e => e.tbl === 'music_mixes').map(e => (db.prepare('SELECT kind FROM music_mixes WHERE id = ?').get(e.k1) as { kind: string }).kind).sort()).toEqual(['ai', 'mood'])

    // On the first sync after the upgrade, all of it goes up, with the songs and artists it names.
    linkProfiles(db, ACCOUNT, clock)
    ackPush(db, collectPush(db, ACCOUNT, clock)!.ids)
    const out = collectMusicPush(db, ACCOUNT, clock)!
    const batch = parseMusicBatch(out.batch as unknown as Record<string, unknown>, clock)
    expect(batch.ratings).toHaveLength(2)
    expect(batch.listens).toHaveLength(2)
    expect(batch.mixes.map(m => m.kind).sort()).toEqual(['ai', 'mood'])
    expect(batch.tracks.map(t => t.id).sort()).toEqual([KESARIYA.id, BROWN.id].sort())
    expect(JSON.stringify(batch)).not.toMatch(/dQw4w9WgXcQ|youtube|music_files/i)
    db.close()
  })
})

describe('music outbox', () => {
  it('queues likes, listens and asked-for mixes once per key; not engine mixes, songs, artists or downloads', () => {
    const me = a.taste.defaultProfile()
    knows(a, KESARIYA)
    a.music.rate(me.id, 'track', KESARIYA.id, 1)
    a.music.rate(me.id, 'track', KESARIYA.id, -1)
    a.music.listen(me.id, KESARIYA, 240, 'ended')
    a.music.saveMix(me.id, { id: 'm0000000000000a1', kind: 'mood', title: 'Rain', subtitle: 'x', tracks: [{ id: KESARIYA.id }], at: clock })
    a.music.saveMix(me.id, { id: 'm0000000000000d1', kind: 'daily', title: 'Your daily mix', subtitle: 'x', tracks: [{ id: KESARIYA.id }], at: clock })
    expect(musicOutbox(a.db).map(e => [e.tbl, e.k2])).toEqual([
      ['music_ratings', `track:${KESARIYA.id}`],
      ['music_listens', ''],
      ['music_mixes', ''],
    ])
    expect(musicOutbox(a.db).find(e => e.tbl === 'music_mixes')!.k1).toBe('m0000000000000a1')
    // The film outbox never sees music.
    expect(pendingCount(a.db)).toBe(1) // the profile
  })

  it('rows pulled from the cloud aren’t queued back', () => {
    const me = a.taste.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    knows(a, KESARIYA)
    a.music.rate(me.id, 'track', KESARIYA.id, 1)
    a.music.listen(me.id, KESARIYA, 240, 'ended')
    relay(a, b)
    expect(musicOutbox(b.db)).toEqual([])
    expect(musicPendingCount(a.db)).toBe(0)
  })
})

describe('pushing music', () => {
  it('builds batches the cloud accepts, each row with the songs and artists it names, once', () => {
    const me = a.taste.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    knows(a, KESARIYA, BROWN, EXCUSES)
    a.music.listen(me.id, KESARIYA, 240, 'ended')
    a.music.listen(me.id, KESARIYA, 120, 'left')
    a.music.rate(me.id, 'track', KESARIYA.id, 1)
    a.music.rate(me.id, 'artist', BROWN.artist.id, 1)
    a.music.saveMix(me.id, { id: 'm0000000000000a1', kind: 'ai', title: 'Late drive', subtitle: 'Punjabi for the road', model: 'gpt-5.1', tracks: [{ id: BROWN.id, why: 'You love his flow' }, { id: EXCUSES.id }], at: clock })
    ackPush(a.db, collectPush(a.db, ACCOUNT, clock)!.ids)

    const out = collectMusicPush(a.db, ACCOUNT, clock)!
    const batch = parseMusicBatch(out.batch as unknown as Record<string, unknown>, clock)
    expect(batch.tracks.map(t => t.id).sort()).toEqual([KESARIYA.id, BROWN.id, EXCUSES.id].sort())
    expect(batch.artists.map(x => x.id).sort()).toEqual([KESARIYA.artist.id, BROWN.artist.id].sort())
    expect(batch.artists[0]).toMatchObject({ deezerId: '4495513', itunesId: '587366', picture: DZ })
    expect(batch.tracks.find(t => t.id === KESARIYA.id)).toMatchObject({ title: 'Kesariya', credit: KESARIYA.credit, albumId: 'it1630340270', cover: IT, duration: 240, rank: 0.5 })
    expect(batch.mixes[0].tracks).toEqual([{ id: BROWN.id, why: 'You love his flow' }, { id: EXCUSES.id, why: null }])
    expect(out.origin.tracks.every(o => o === null)).toBe(true)
    expect(out.ids).toHaveLength(5)
    expect(JSON.stringify(batch)).not.toMatch(/seen_at|seenAt/)
  })

  it('leaves out details the cloud wouldn’t take rather than the row', () => {
    const w = trackWire({ id: KESARIYA.id, title: `  ${'Kesariya '.repeat(40)}`, credit: 'a\u0000b', artist_id: KESARIYA.artist.id, artist: 'Arijit Singh', picture: 'http://example.com/a.jpg', album_id: 'yt1', album: 'Brahmastra', cover: IT, duration: 268.4, explicit: 1, rank: 7 })!
    expect(w).toMatchObject({ credit: null, picture: null, albumId: null, album: 'Brahmastra', cover: IT, duration: 268, explicit: 1, rank: 1 })
    expect([...w.title].length).toBeLessThanOrEqual(200)
    expect(parseMusicBatch({ tracks: [w] }, clock).tracks).toHaveLength(1)
    // Without a usable title there's nothing to show, so the song isn't sent (the rows naming it still are).
    expect(trackWire({ ...w, title: 'magnet:?xt=urn:btih:abc', artist_id: w.artistId } as never)).toBeNull()
  })

  it('caps a push at the row limit, counting the songs and artists a row brings', () => {
    const me = a.taste.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    const songs = Array.from({ length: 12 }, (_, i) => song('Arijit Singh', `Song ${i}`))
    knows(a, ...songs)
    for (const t of songs) a.music.listen(me.id, t, 240, 'ended')
    ackPush(a.db, collectPush(a.db, ACCOUNT, clock)!.ids)
    const first = collectMusicPush(a.db, ACCOUNT, clock, { maxRows: 10 })!
    // listen 1 brings its song and the artist (3 rows); each later one, its song (2 rows).
    expect(Object.values(first.batch).flat()).toHaveLength(9)
    expect(first.batch.listens).toHaveLength(4)
    ackMusicPush(a.db, first.ids)
    let pushed = first.batch.listens.length
    for (let out = collectMusicPush(a.db, ACCOUNT, clock, { maxRows: 10 }); out; out = collectMusicPush(a.db, ACCOUNT, clock, { maxRows: 10 })) {
      expect(Object.values(out.batch).flat().length).toBeLessThanOrEqual(10)
      expect(out.batch.artists).toHaveLength(1) // every batch carries what its rows name
      pushed += out.batch.listens.length
      ackMusicPush(a.db, out.ids)
    }
    expect(pushed).toBe(12)
    expect(LIMITS.pushItems).toBe(500)
  })

  it('waits for profiles the cloud doesn’t have yet; keeps another account’s rows; drops a deleted profile’s', () => {
    const me = a.taste.defaultProfile()
    knows(a, KESARIYA)
    linkProfiles(a.db, ACCOUNT, clock)
    a.music.listen(me.id, KESARIYA, 240, 'ended')
    // "Me" is still in the film outbox: its music waits until the film push has sent it.
    expect(collectMusicPush(a.db, ACCOUNT, clock)).toBeNull()
    expect(musicPendingCount(a.db)).toBe(1)
    ackPush(a.db, collectPush(a.db, ACCOUNT, clock)!.ids)
    expect(collectMusicPush(a.db, ACCOUNT, clock)!.batch.listens).toHaveLength(1)

    // A profile made while signed in but not yet on the account is queued for the film push.
    const kid = a.taste.createProfile({ name: 'Kid' })
    a.db.prepare("DELETE FROM sync_outbox WHERE tbl = 'profiles' AND k1 = ?").run(kid.id)
    a.music.listen(kid.id, KESARIYA, 240, 'ended')
    const theirs = a.taste.createProfile({ name: 'Theirs' })
    a.db.prepare('UPDATE profiles SET account_id = ? WHERE id = ?').run('22222222-2222-4222-8222-222222222222', theirs.id)
    a.music.rate(theirs.id, 'track', KESARIYA.id, 1)
    const gone = a.taste.createProfile({ name: 'Gone' })
    a.music.rate(gone.id, 'track', KESARIYA.id, -1)
    a.taste.deleteProfile(gone.id)

    const out = collectMusicPush(a.db, ACCOUNT, clock)!
    expect(out.batch.listens.map(l => l.profileId)).toEqual([me.id])
    expect(out.batch.ratings).toEqual([])
    expect(a.db.prepare("SELECT 1 FROM sync_outbox WHERE tbl = 'profiles' AND k1 = ?").get(kid.id)).toBeTruthy()
    ackMusicPush(a.db, out.ids)
    const left = musicOutbox(a.db)
    expect(left.some(e => e.tbl === 'music_ratings' && e.k1 === theirs.id)).toBe(true)
    expect(left.some(e => e.k1 === gone.id)).toBe(false)
  })
})

describe('applying a music pull', () => {
  it('carries likes, listens and asked-for mixes to another computer, which can show them', () => {
    const me = a.taste.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    knows(a, KESARIYA, BROWN, EXCUSES)
    a.music.rate(me.id, 'track', KESARIYA.id, 1, { name: 'Kesariya', picture: IT })
    a.music.rate(me.id, 'artist', BROWN.artist.id, 1, { name: 'AP Dhillon', picture: DZ })
    a.music.listen(me.id, EXCUSES, 240, 'ended')
    a.music.saveMix(me.id, { id: 'm0000000000000a1', kind: 'ai', title: 'Late drive', subtitle: 'Punjabi for the road', model: 'gpt-5.1', tracks: [{ id: BROWN.id, why: 'You love his flow' }, { id: EXCUSES.id }], at: clock })
    relay(a, b)

    expect(b.music.liked(me.id).map(t => [t.title, t.album?.cover])).toEqual([['Kesariya', IT]])
    expect(b.music.likedArtists(me.id).map(x => x.name)).toEqual(['AP Dhillon'])
    expect(b.music.recent(me.id, 10).map(t => t.title)).toEqual(['Excuses'])
    expect(b.music.history(me.id, 0)).toHaveLength(1)
    expect(b.music.mixes(me.id).map(m => [m.kind, m.title, m.tracks])).toEqual([['ai', 'Late drive', [{ id: BROWN.id, why: 'You love his flow' }, { id: EXCUSES.id }]]])
    expect(b.music.tracks([BROWN.id, EXCUSES.id]).map(t => t.title)).toEqual(['Brown Munde', 'Excuses'])
    // Where each catalog keeps the artist came along, for artist mixes and radio.
    expect(b.music.get(BROWN.artist.id)).toMatchObject({ name: 'AP Dhillon', deezer: '4495513', itunes: '587366' })
    expect(musicOutbox(b.db)).toEqual([])
  })

  it('likes: last write wins on updatedAt, ties go to the pulled row', () => {
    const me = a.taste.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    knows(a, KESARIYA)
    a.music.rate(me.id, 'track', KESARIYA.id, 1, { name: 'Kesariya' })
    relay(a, b)
    clock += 60_000
    b.music.rate(me.id, 'track', KESARIYA.id, -1)
    applyMusicPull(b.db, { ratings: [{ profileId: me.id, kind: 'track', itemId: KESARIYA.id, value: 1, name: null, picture: null, updatedAt: clock - 30_000 }] }, clock)
    expect(b.music.rating(me.id, 'track', KESARIYA.id)).toBe(-1)
    applyMusicPull(b.db, { ratings: [{ profileId: me.id, kind: 'track', itemId: KESARIYA.id, value: 0, name: null, picture: null, updatedAt: clock }] }, clock)
    expect(b.music.rating(me.id, 'track', KESARIYA.id)).toBe(0)
    expect(b.db.prepare('SELECT name FROM music_ratings WHERE item_id = ?').get(KESARIYA.id)).toMatchObject({ name: 'Kesariya' })
  })

  it('fills gaps in a song this computer knows, and never overwrites it', () => {
    knows(b, { ...KESARIYA, album: undefined, credit: undefined, duration: 0 })
    const w = trackWire({ id: KESARIYA.id, title: 'Other title', credit: 'Pritam', artist_id: KESARIYA.artist.id, artist: 'Arijit Singh', picture: DZ, album_id: 'it1', album: 'Brahmastra', cover: IT, duration: 268, explicit: 0, rank: 0.2 })!
    applyMusicPull(b.db, { tracks: [w] }, clock)
    expect(b.music.track(KESARIYA.id)).toMatchObject({ title: 'Kesariya', credit: 'Pritam', album: { id: 'it1', title: 'Brahmastra', cover: IT }, duration: 268, rank: 0.5 })
  })
})

describe('signing in on a second computer', () => {
  it('merges music of a same-name profile into the account’s, newer like winning, and drops engine mixes', () => {
    const me = a.taste.defaultProfile()
    linkProfiles(a.db, ACCOUNT, clock)
    knows(a, KESARIYA)
    a.music.rate(me.id, 'track', KESARIYA.id, 1)
    a.music.listen(me.id, KESARIYA, 240, 'ended')
    relay(a, b)

    // B had its own "Me", with music, before signing in.
    const bMe = uuidv7(clock)
    b.db.prepare("INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at) VALUES (?, NULL, 'Me', NULL, ?, ?)").run(bMe, clock, clock)
    knows(b, KESARIYA, BROWN, EXCUSES)
    clock += 1000
    b.music.rate(bMe, 'track', KESARIYA.id, -1) // newer than A's like: wins
    b.music.rate(bMe, 'artist', BROWN.artist.id, 1)
    b.music.listen(bMe, EXCUSES, 240, 'ended')
    b.music.saveMix(bMe, { id: 'm0000000000000a1', kind: 'mood', title: 'Rain', subtitle: 'From playlists like “Monsoon”, picked for you', tracks: [{ id: EXCUSES.id }], at: clock })
    b.music.saveMix(bMe, { id: 'm0000000000000d1', kind: 'daily', title: 'Your daily mix', subtitle: 'x', tracks: [{ id: EXCUSES.id }], at: clock })
    b.music.saveMix(me.id, { id: 'm0000000000000d2', kind: 'daily', title: 'Your daily mix', subtitle: 'x', tracks: [{ id: KESARIYA.id }], at: clock })

    expect(linkProfiles(b.db, ACCOUNT, clock)).toEqual({ [bMe]: me.id })
    expect(b.music.rating(me.id, 'track', KESARIYA.id)).toBe(-1)
    expect(b.music.rating(me.id, 'artist', BROWN.artist.id)).toBe(1)
    expect(b.music.listenCount(me.id)).toBe(2)
    expect(b.music.mixes(me.id).map(m => m.kind)).toEqual(['mood']) // engine mixes are remade from the merged taste
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM music_ratings WHERE profile_id = ?').get(bMe)).toEqual({ n: 0 })

    const pushed = relay(b, a)
    expect(pushed.ratings.map(r => [r.profileId, r.itemId, r.value]).sort()).toEqual([[me.id, BROWN.artist.id, 1], [me.id, KESARIYA.id, -1]].sort())
    expect(pushed.listens.map(l => l.profileId)).toEqual([me.id])
    expect(pushed.mixes.map(m => [m.profileId, m.kind])).toEqual([[me.id, 'mood']])
    expect(JSON.stringify(pushed)).not.toContain(bMe)
    expect(a.music.rating(me.id, 'track', KESARIYA.id)).toBe(-1)
    expect(a.music.listenCount(me.id)).toBe(2)
  })

  it('a "Me" with music of its own isn’t the untouched starter, so it stays a profile of its own', () => {
    const owner = a.taste.createProfile({ name: 'Alex' })
    a.db.prepare('UPDATE profiles SET account_id = ?').run(ACCOUNT)
    relay(a, b)
    const bMe = uuidv7(clock)
    b.db.prepare("INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at) VALUES (?, NULL, 'Me', NULL, ?, ?)").run(bMe, clock, clock)
    knows(b, KESARIYA)
    b.music.listen(bMe, KESARIYA, 240, 'ended')
    expect(linkProfiles(b.db, ACCOUNT, clock)).toEqual({})
    expect(b.taste.listProfiles().map(x => x.name).sort()).toEqual(['Alex', 'Me'])
    expect(relay(b, a).listens.map(l => l.profileId)).toEqual([bMe])
    expect(owner.id).toBeTruthy()
  })
})

// ---- The service against an old and a new cloud ---------------------------------------------------

/** A stand-in cloud: films always; music only when `music` is on, as a Worker before and after 0005_music.sql. */
function fakeCloud (opts: { music: boolean; musicFails?: boolean }) {
  const calls: string[] = []
  let seq = 0
  let musicSeq = 0
  const musicRows: MusicBatch[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url))
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const count = () => Object.values(body).reduce((n: number, v) => n + (Array.isArray(v) ? v.length : 0), 0)
    switch (u.pathname) {
      case '/v1/auth/prelogin': return Response.json({ kdf: 'pbkdf2-sha256', iterations: 100_000, salt: 'c2FsdHNhbHRzYWx0c2FsdA' })
      case '/v1/auth/login': return Response.json({ token: `nxs_${'a'.repeat(43)}`, expiresAt: Date.now() + 1e9, account: { id: ACCOUNT, email: 'me@example.com', displayName: null, role: 'member', createdAt: 0 } })
      case '/v1/sync/push': parseBatch(body, Date.now()); seq += count(); return Response.json({ applied: {}, serverTime: Date.now() })
      case '/v1/sync/pull': return Response.json({ cursor: String(seq), more: false, serverTime: Date.now(), ...emptyBatch(), ...(opts.music ? { musicHead: String(musicSeq) } : {}) })
    }
    if (opts.music && u.pathname === '/v1/sync/music/push') {
      if (opts.musicFails) return Response.json({ error: 'internal', message: 'Something went wrong' }, { status: 500 })
      musicRows.push(parseMusicBatch(body, Date.now()))
      seq += count()
      musicSeq = seq
      return Response.json({ applied: {}, musicHead: String(musicSeq), serverTime: Date.now() })
    }
    if (opts.music && u.pathname === '/v1/sync/music/pull') return Response.json({ cursor: String(seq), more: false, serverTime: Date.now(), ...emptyMusicBatch() })
    return Response.json({ error: 'not_found', message: 'Not found' }, { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl, musicRows }
}

describe('the sync service', () => {
  let dir: string
  let d: Device
  let logs: string[]
  beforeEach(() => {
    clock = Date.now()
    dir = mkdtempSync(join(tmpdir(), 'nexttupp-music-sync-'))
    d = device()
    logs = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const service = (fetchImpl: typeof fetch) => new SyncService({ db: d.db, store: d.taste, dataDir: dir, cloudUrl: 'https://cloud.invalid', fetch: fetchImpl, log: m => logs.push(m) })
  const tasteAndMusic = () => {
    const me = d.taste.defaultProfile()
    d.taste.setRating(me.id, { id: 'tt0112471', type: 'movie' }, 1)
    knows(d, KESARIYA)
    d.music.rate(me.id, 'track', KESARIYA.id, 1)
    d.music.listen(me.id, KESARIYA, 240, 'ended')
    return me
  }

  it('on a cloud that doesn’t sync music yet, films sync as before and music waits quietly', async () => {
    const cloud = fakeCloud({ music: false })
    const sync = service(cloud.fetchImpl)
    try {
      tasteAndMusic()
      const status = await sync.login('me@example.com', 'correct horse battery')
      await sync.syncNow()
      expect(status.sync).toMatchObject({ state: 'synced', error: null, pending: 0 })
      expect(sync.status().sync).toMatchObject({ state: 'synced', error: null, pending: 0 })
      expect(cloud.calls).toContain('POST /v1/sync/push')
      expect(cloud.calls.some(c => c.includes('/music/'))).toBe(false)
      expect(musicPendingCount(d.db)).toBeGreaterThan(0)
      expect(logs.filter(m => /music/.test(m))).toHaveLength(1)
    } finally { sync.stop() }
  })

  it('on a cloud that does, music goes up after the films and is pulled only when it changed', async () => {
    const cloud = fakeCloud({ music: true })
    const sync = service(cloud.fetchImpl)
    try {
      const me = tasteAndMusic()
      await sync.login('me@example.com', 'correct horse battery')
      const sequence = cloud.calls.filter(c => c.includes('/v1/sync/'))
      expect(sequence.indexOf('POST /v1/sync/music/push')).toBeGreaterThan(sequence.lastIndexOf('POST /v1/sync/push'))
      expect(sequence).toContain('GET /v1/sync/music/pull')
      expect(cloud.musicRows.flatMap(r => r.ratings).map(r => r.itemId)).toEqual([KESARIYA.id])
      expect(musicPendingCount(d.db)).toBe(0)
      expect(sync.status().sync).toMatchObject({ state: 'synced', pending: 0 })

      // Nothing new: no music calls at all.
      cloud.calls.length = 0
      await sync.syncNow()
      expect(cloud.calls.filter(c => c.includes('/music/'))).toEqual([])

      d.music.rate(me.id, 'artist', KESARIYA.artist.id, 1)
      await sync.syncNow()
      expect(cloud.calls.filter(c => c.includes('/music/'))).toEqual(['POST /v1/sync/music/push', 'GET /v1/sync/music/pull'])
      expect(logs.filter(m => /music/.test(m))).toEqual([])
    } finally { sync.stop() }
  })

  it('a music failure is logged once and doesn’t fail the film sync', async () => {
    const cloud = fakeCloud({ music: true, musicFails: true })
    const sync = service(cloud.fetchImpl)
    try {
      tasteAndMusic()
      await sync.login('me@example.com', 'correct horse battery')
      await sync.syncNow()
      expect(sync.status().sync).toMatchObject({ state: 'synced', error: null })
      expect(sync.status().sync!.pending).toBeGreaterThan(0) // the music rows, still waiting
      expect(logs.filter(m => /music/.test(m))).toHaveLength(1)
    } finally { sync.stop() }
  })
})
