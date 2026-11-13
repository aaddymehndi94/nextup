import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/wire.ts'
import { call, makeMember, profile, pull, push, T0, type User } from './helpers.ts'

// Music sync: POST /v1/sync/music/push and GET /v1/sync/music/pull (src/music.ts), and the film pull's musicHead.

const musicPush = (u: User, body: unknown) => call('POST', '/v1/sync/music/push', { token: u.token, body })
const musicPull = (u: User, since = '0', limit?: number) => call('GET', `/v1/sync/music/pull?since=${since}${limit ? `&limit=${limit}` : ''}`, { token: u.token })

const DZ = (kind: string) => `https://cdn-images.dzcdn.net/images/${kind}/0123456789abcdef0123456789abcdef/500x500-000000-80-0-0.jpg`
const IT = 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/aa/bb/cc/aabbcc00-1111-2222-3333-444455556666/source/600x600bb.jpg'
const TRACK = 't0123456789abcdef'
const TRACK2 = 'tfedcba9876543210'
const ARTIST = 'a0123456789ab'

const artistRow = (over: Record<string, unknown> = {}) => ({ id: ARTIST, name: 'Arijit Singh', picture: DZ('artist'), itunesId: '1000', deezerId: '2000', ...over })
const trackRow = (over: Record<string, unknown> = {}) => ({
  id: TRACK, title: 'Kesariya', credit: 'Pritam, Arijit Singh & Amitabh Bhattacharya', artistId: ARTIST, artist: 'Arijit Singh', picture: DZ('artist'),
  albumId: 'it1630340270', album: 'Brahmastra', cover: IT, duration: 268, explicit: 0, rank: 0.8, ...over,
})
const rating = (pid: string, over: Record<string, unknown> = {}) => ({ profileId: pid, kind: 'track', itemId: TRACK, value: 1, name: 'Kesariya', picture: IT, updatedAt: T0 + 10, ...over })
const listen = (pid: string, over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), profileId: pid, trackId: TRACK, artistId: ARTIST, played: 268, outcome: 'complete', at: T0 + 20, ...over })
const mix = (pid: string, over: Record<string, unknown> = {}) => ({
  id: 'm0123456789abcde', profileId: pid, kind: 'ai', title: 'Monsoon evenings', subtitle: 'Soft songs for rain', model: 'gpt-5.1',
  tracks: [{ id: TRACK, why: 'You play him most' }, { id: TRACK2, why: null }], at: T0 + 30, ...over,
})

function fullMusic (pid: string) {
  return {
    artists: [artistRow()],
    tracks: [trackRow(), trackRow({ id: TRACK2, title: 'Apna Bana Le', credit: null, picture: null, albumId: null, album: null, cover: null, rank: 0 })],
    ratings: [rating(pid), rating(pid, { kind: 'artist', itemId: ARTIST, value: -1, name: null, picture: null })],
    listens: [listen(pid), listen(pid, { trackId: TRACK2, played: 12.5, outcome: 'skip', at: T0 + 21 })],
    mixes: [mix(pid), mix(pid, { id: 'm00000000000000f', kind: 'mood', title: 'Rainy evening', subtitle: 'From playlists like “Monsoon”, picked for you', model: null })],
  }
}

/** A member with one profile on the account (pushed the film way, as the app does first). */
async function withProfile (): Promise<{ u: User; pid: string }> {
  const u = await makeMember()
  const pid = crypto.randomUUID()
  expect((await push(u, { profiles: [profile({ id: pid })] })).status).toBe(200)
  return { u, pid }
}

describe('music push and pull', () => {
  it('round-trips every section exactly, and the film pull says where music last changed', async () => {
    const { u, pid } = await withProfile()
    const batch = fullMusic(pid)
    const r = await musicPush(u, batch)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.applied).toEqual({ artists: 1, tracks: 2, ratings: 2, listens: 2, mixes: 2 })
    expect(r.body.musicHead).toBe('10') // the profile took seq 1, these rows 2–10

    const p = await musicPull(u)
    expect(p.status).toBe(200)
    expect(p.body.more).toBe(false)
    expect(p.body.cursor).toBe('10')
    for (const s of ['artists', 'tracks', 'ratings', 'listens', 'mixes'] as const) expect(p.body[s], s).toEqual(batch[s])

    // Films and music stay apart: the film pull carries no music rows, only the head.
    const films = await pull(u)
    expect(films.body.musicHead).toBe('10')
    expect(Object.keys(films.body).sort()).toEqual(['cursor', 'dismissals', 'events', 'list', 'more', 'musicHead', 'prefs', 'profiles', 'progress', 'ratings', 'serverTime'])
    expect(JSON.stringify(films.body)).not.toContain('Kesariya')
    expect(films.body.cursor).toBe('1')
  })

  it('a film push still refuses music sections, as before', async () => {
    const { u, pid } = await withProfile()
    const r = await push(u, { listens: [listen(pid)] })
    expect(r.status).toBe(400)
    expect(r.body.message).toBe('body: unknown field "listens"')
  })

  it('is idempotent: the same batch again writes nothing and moves no cursor', async () => {
    const { u, pid } = await withProfile()
    const batch = fullMusic(pid)
    await musicPush(u, batch)
    const first = await musicPull(u)
    const again = await musicPush(u, batch)
    expect(Object.values(again.body.applied).every(n => n === 0)).toBe(true)
    const after = await musicPull(u, first.body.cursor)
    for (const s of ['artists', 'tracks', 'ratings', 'listens', 'mixes']) expect(after.body[s], s).toEqual([])
  })

  it('songs and artists only fill gaps: a re-sent song with nothing new costs nothing, a better one fills in', async () => {
    const { u, pid } = await withProfile()
    const bare = trackRow({ credit: null, picture: null, albumId: null, album: null, cover: null, duration: 0, rank: 0 })
    await musicPush(u, { tracks: [bare], artists: [artistRow({ picture: null, itunesId: null })], listens: [listen(pid)] })
    const c = (await musicPull(u)).body.cursor
    // The same song with a different title or artist name doesn't overwrite what's there.
    expect((await musicPush(u, { tracks: [{ ...bare, title: 'Something else' }] })).body.applied.tracks).toBe(0)
    // A fuller description fills every gap once.
    const r = await musicPush(u, { tracks: [trackRow({ credit: 'Pritam' })], artists: [artistRow({ picture: DZ('artist'), deezerId: '9' })] })
    expect(r.body.applied).toMatchObject({ tracks: 1, artists: 1 })
    const p = await musicPull(u, c)
    expect(p.body.tracks).toEqual([{ ...trackRow({ credit: 'Pritam' }), title: 'Kesariya' }])
    expect(p.body.artists).toEqual([artistRow({ deezerId: '2000', itunesId: '1000' })])
    expect((await musicPush(u, { tracks: [trackRow()], artists: [artistRow()] })).body.applied).toMatchObject({ tracks: 0, artists: 0 })
  })

  it('likes: last write wins on updatedAt, ties keep the server copy, and 0 is kept as a change of mind', async () => {
    const { u, pid } = await withProfile()
    expect((await musicPush(u, { ratings: [rating(pid, { updatedAt: T0 + 200 })] })).body.applied.ratings).toBe(1)
    expect((await musicPush(u, { ratings: [rating(pid, { value: -1, updatedAt: T0 + 100 })] })).body.applied.ratings).toBe(0)
    expect((await musicPush(u, { ratings: [rating(pid, { value: -1, updatedAt: T0 + 200 })] })).body.applied.ratings).toBe(0)
    const c = (await musicPull(u)).body.cursor
    expect((await musicPush(u, { ratings: [rating(pid, { value: 0, name: null, updatedAt: T0 + 300 })] })).body.applied.ratings).toBe(1)
    // A newer row without a name keeps the stored one.
    expect((await musicPull(u, c)).body.ratings).toEqual([rating(pid, { value: 0, updatedAt: T0 + 300 })])
  })

  it('listens are kept once per id; mixes are last-write-wins on `at`', async () => {
    const { u, pid } = await withProfile()
    const l = listen(pid)
    await musicPush(u, { listens: [l], mixes: [mix(pid, { at: T0 + 50 })] })
    expect((await musicPush(u, { listens: [{ ...l, played: 1, outcome: 'skip' }] })).body.applied.listens).toBe(0)
    expect((await musicPush(u, { mixes: [mix(pid, { title: 'Older', at: T0 + 40 })] })).body.applied.mixes).toBe(0)
    expect((await musicPush(u, { mixes: [mix(pid, { title: 'Asked again', at: T0 + 60 })] })).body.applied.mixes).toBe(1)
    const p = (await musicPull(u)).body
    expect(p.listens).toEqual([l])
    expect(p.mixes).toEqual([mix(pid, { title: 'Asked again', at: T0 + 60 })])
  })

  it('keeps the newest 12 asked-for mixes per profile', async () => {
    const { u, pid } = await withProfile()
    const mixes = Array.from({ length: 15 }, (_, i) => mix(pid, { id: `m${i.toString(16).padStart(15, '0')}`, at: T0 + i }))
    await musicPush(u, { mixes: mixes.slice(0, 10) })
    await musicPush(u, { mixes: mixes.slice(10) })
    const kept = (await musicPull(u)).body.mixes.map((m: { at: number }) => m.at - T0).sort((a: number, b: number) => a - b)
    expect(kept).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(LIMITS.musicMixesPerProfile).toBe(12)
  })

  it('the cursor reaches the head, so a client can skip the music pull until musicHead moves past it', async () => {
    const { u, pid } = await withProfile()
    const r = await musicPush(u, { listens: [listen(pid)] })
    // Film changes move the account's counter but not musicHead.
    await push(u, { ratings: [{ profileId: pid, itemId: 'tt0133093', itemType: 'movie', value: 1, source: null, updatedAt: T0 }] })
    const p = await musicPull(u)
    expect(Number(p.body.cursor)).toBeGreaterThan(Number(r.body.musicHead))
    expect((await pull(u)).body.musicHead).toBe(r.body.musicHead)
    // Nothing after it; a later music push moves the head past the cursor.
    expect((await musicPull(u, p.body.cursor)).body.listens).toEqual([])
    const r2 = await musicPush(u, { listens: [listen(pid)] })
    expect(Number(r2.body.musicHead)).toBeGreaterThan(Number(p.body.cursor))
    expect((await musicPull(u, p.body.cursor)).body.listens).toHaveLength(1)
  })

  it('pages through large pulls without gaps or repeats', async () => {
    const { u, pid } = await withProfile()
    const listens = Array.from({ length: 30 }, (_, i) => listen(pid, { at: T0 + i }))
    await musicPush(u, { artists: [artistRow()], tracks: [trackRow()], listens })
    const seen = new Set<string>()
    let cursor = '0'
    let pages = 0
    for (;;) {
      const p = await musicPull(u, cursor, 7)
      pages++
      for (const l of p.body.listens) { expect(seen.has(l.id)).toBe(false); seen.add(l.id) }
      expect(Number(p.body.cursor)).toBeGreaterThan(Number(cursor))
      cursor = p.body.cursor
      if (!p.body.more) break
    }
    expect(seen.size).toBe(30)
    expect(pages).toBe(5) // 32 rows, 7 per page
  })

  it('rejects a cursor from the future, and needs a session', async () => {
    const { u } = await withProfile()
    expect((await musicPull(u, '999999')).body.error).toBe('cursor_ahead')
    expect((await call('POST', '/v1/sync/music/push', { body: {} })).status).toBe(401)
    expect((await call('GET', '/v1/sync/music/pull')).status).toBe(401)
  })
})

describe('music account isolation', () => {
  it("one account can't read another's music or write under its profiles", async () => {
    const a = await withProfile()
    const b = await withProfile()
    await musicPush(a.u, fullMusic(a.pid))
    const view = (await musicPull(b.u)).body
    for (const s of ['artists', 'tracks', 'ratings', 'listens', 'mixes']) expect(view[s], s).toEqual([])
    const w = await musicPush(b.u, { ratings: [rating(a.pid, { updatedAt: T0 + 99_999 })] })
    expect(w.status).toBe(409)
    expect(w.body.error).toBe('profile_conflict')
    // The same song pushed by B is B's own copy: songs are stored per account.
    expect((await musicPush(b.u, { tracks: [trackRow({ title: 'B’s title' })] })).body.applied.tracks).toBe(1)
    expect((await musicPull(a.u)).body.tracks.find((t: { id: string }) => t.id === TRACK).title).toBe('Kesariya')
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM music_tracks WHERE id = ?').bind(TRACK).first<{ n: number }>()
    expect(n!.n).toBeGreaterThanOrEqual(2)
  })

  it('rows must name a profile already on this account (the film push carries profiles)', async () => {
    const u = await makeMember()
    const r = await musicPush(u, { listens: [listen(crypto.randomUUID())] })
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('unknown_profile')
  })
})

describe('music payload validation', () => {
  let u: User
  let pid: string
  beforeAll(async () => { ({ u, pid } = await withProfile()) })

  const HASH = 'c9e15763f722f23e98a29decdfae341b98d53056'
  const cases: Array<[string, () => unknown]> = [
    ['unknown section', () => ({ downloads: [] })],
    ['a film section', () => ({ profiles: [] })],
    ['unknown field on a song', () => ({ tracks: [{ ...trackRow(), youtubeId: 'dQw4w9WgXcQ' }] })],
    ['a song id that isn’t the app’s', () => ({ tracks: [trackRow({ id: '12345' })] })],
    ['an info hash as a song title', () => ({ tracks: [trackRow({ title: HASH })] })],
    ['a magnet link as an artist name', () => ({ artists: [artistRow({ name: `magnet:?xt=urn:btih:${HASH}` })] })],
    ['a file name as an album', () => ({ tracks: [trackRow({ album: 'Kesariya.mp4' })] })],
    ['control characters in a title', () => ({ tracks: [trackRow({ title: 'a\u0000b' })] })],
    ['a picture from another host', () => ({ artists: [artistRow({ picture: 'https://example.com/a.jpg' })] })],
    ['a picture over http', () => ({ tracks: [trackRow({ cover: IT.replace('https:', 'http:') })] })],
    ['a picture link with credentials', () => ({ tracks: [trackRow({ cover: IT.replace('https://', 'https://u:p@') })] })],
    ['a bad album id', () => ({ tracks: [trackRow({ albumId: 'yt123' })] })],
    ['a fractional duration', () => ({ tracks: [trackRow({ duration: 1.5 })] })],
    ['rank above 1', () => ({ tracks: [trackRow({ rank: 3 })] })],
    ['explicit as a boolean', () => ({ tracks: [trackRow({ explicit: true })] })],
    ['a text catalog id', () => ({ artists: [artistRow({ deezerId: 'abc' })] })],
    ['an artist like with a song id', () => ({ ratings: [rating(pid, { kind: 'artist' })] })],
    ['a like of 2', () => ({ ratings: [rating(pid, { value: 2 })] })],
    ['a like from the future', () => ({ ratings: [rating(pid, { updatedAt: Date.now() + 2 * 3600_000 })] })],
    ['a listen with a non-UUID id', () => ({ listens: [listen(pid, { id: 'x' })] })],
    ['a negative listen', () => ({ listens: [listen(pid, { played: -1 })] })],
    ['an unknown outcome', () => ({ listens: [listen(pid, { outcome: 'liked' })] })],
    ['an engine mix', () => ({ mixes: [mix(pid, { kind: 'daily' })] })],
    ['a mix with no songs', () => ({ mixes: [mix(pid, { tracks: [] })] })],
    ['a mix with too many songs', () => ({ mixes: [mix(pid, { tracks: Array.from({ length: 61 }, () => ({ id: TRACK, why: null })) })] })],
    ['a mix song with extra fields', () => ({ mixes: [mix(pid, { tracks: [{ id: TRACK, why: null, url: 'https://x' }] })] })],
    ['a mix as a string blob', () => ({ mixes: [mix(pid, { tracks: JSON.stringify([{ id: TRACK }]) })] })],
    ['an over-long mix title', () => ({ mixes: [mix(pid, { title: 'x'.repeat(81) })] })],
  ]

  it.each(cases)('rejects %s', async (_name, make) => {
    const r = await musicPush(u, make())
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toBe('invalid')
  })

  it('takes long words in titles, which plain names refuse', async () => {
    const r = await musicPush(u, { tracks: [trackRow({ id: 't1111111111111111', title: 'Supercalifragilisticexpialidocious' })] })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('names the offending row, and a refused push stores nothing', async () => {
    const before = (await musicPull(u)).body.cursor
    const r = await musicPush(u, { listens: [listen(pid), listen(pid, { outcome: 'nope' })] })
    expect(r.body.message).toMatch(/^listens\[1\]\.outcome:/)
    expect((await musicPull(u)).body.cursor).toBe(before)
  })

  it('limits batch size like films', async () => {
    const many = Array.from({ length: LIMITS.pushItems + 1 }, () => listen(pid))
    expect((await musicPush(u, { listens: many })).status).toBe(413)
    const exact = Array.from({ length: LIMITS.pushItems }, () => listen(pid))
    expect((await musicPush(u, { listens: exact })).body.applied.listens).toBe(LIMITS.pushItems)
  })

  it('validates pull parameters', async () => {
    expect((await call('GET', '/v1/sync/music/pull?since=abc', { token: u.token })).status).toBe(400)
    expect((await call('GET', '/v1/sync/music/pull?since=0&limit=5000', { token: u.token })).status).toBe(400)
    expect((await call('GET', '/v1/sync/music/pull?since=0&x=1', { token: u.token })).status).toBe(400)
  })
})
