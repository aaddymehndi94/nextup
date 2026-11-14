import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicTrack } from '../../shared/music.ts'
import { artSize } from '../../shared/music.ts'
import { openDb } from '../db.ts'
import type { CastDevice, CastDiscovery } from '../cast/discovery.ts'
import type { LoadRequest, MediaReceiver, MediaStatus } from '../cast/protocol.ts'
import { MusicCast } from './cast.ts'
import { artistIdOf, baseTitle, fromDeezer, fromItunes, normName, Pacer, splitCredit, trackIdOf } from './catalog.ts'
import { arrange, buildTaste, byPosition, score, seedArtists } from './engine.ts'
import { MusicFiles } from './files.ts'
import { parseLrc } from './lyrics.ts'
import { lyricsAss } from './render.ts'
import type { AudioSource } from './source.ts'
import { MusicStore, outcomeOf } from './store.ts'
import { pickUpload, YoutubeSource } from './youtube.ts'

const track = (artist: string, title: string, extra: Partial<MusicTrack> = {}): MusicTrack => ({
  id: trackIdOf(artist, title), title, artist: { id: artistIdOf(splitCredit(artist)[0]), name: splitCredit(artist)[0] }, duration: 200, ...extra,
})

describe('names and ids', () => {
  it('makes one id for one song from either catalog', () => {
    expect(trackIdOf('Pritam, Arijit Singh & Amitabh Bhattacharya', 'Kesariya (From "Brahmastra")')).toBe(trackIdOf('Pritam', 'Kesariya'))
    expect(trackIdOf('Coldplay', 'Yellow - 2011 Remaster')).toBe(trackIdOf('COLDPLAY', 'Yellow'))
    expect(trackIdOf('Beyoncé', 'Halo')).toBe(trackIdOf('Beyonce', 'Halo'))
    expect(trackIdOf('Coldplay', 'Yellow (Live)')).not.toBe(trackIdOf('Coldplay', 'Yellow'))
  })

  it('splits credits and cleans titles', () => {
    expect(splitCredit('Pritam, Arijit Singh & Amitabh Bhattacharya')).toEqual(['Pritam', 'Arijit Singh', 'Amitabh Bhattacharya'])
    expect(splitCredit('Drake feat. Rihanna')).toEqual(['Drake', 'Rihanna'])
    expect(splitCredit('Karan Aujla x Ikky')).toEqual(['Karan Aujla', 'Ikky'])
    expect(splitCredit('X Ambassadors')).toEqual(['X Ambassadors'])
    expect(splitCredit('AC/DC')).toEqual(['AC/DC'])
    expect(baseTitle('Tum Hi Ho (feat. Mithoon) [From "Aashiqui 2"]')).toBe('Tum Hi Ho')
    expect(normName('  AC/DC  ')).toBe('ac dc')
  })

  it('reads both catalogs into the same shape', () => {
    const it1 = fromItunes({ wrapperType: 'track', kind: 'song', trackName: 'Gerua', artistName: 'Pritam, Arijit Singh & Antara Mitra', artistId: 1, collectionId: 9, collectionName: 'Dilwale', artworkUrl100: 'https://x/a/100x100bb.jpg', trackTimeMillis: 345000 })!
    expect(it1).toMatchObject({ title: 'Gerua', artist: { name: 'Pritam' }, credit: 'Pritam, Arijit Singh & Antara Mitra', duration: 345, album: { id: 'it9', cover: 'https://x/a/600x600bb.jpg' } })
    const dz = fromDeezer({ title: 'Gerua', duration: 345, rank: 500000, artist: { id: 5, name: 'Arijit Singh & Antara Mitra' }, album: { id: 7, title: 'Dilwale', md5_image: 'abc' } })!
    expect(dz.artist.name).toBe('Arijit Singh')
    expect(dz.credit).toBe('Arijit Singh & Antara Mitra')
    expect(dz.deezerArtist.deezer).toBeUndefined()
    expect(dz.rank).toBe(0.5)
    expect(artSize('https://x/a/600x600bb.jpg', 1000)).toBe('https://x/a/1000x1000bb.jpg')
    expect(artSize('https://cdn-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg', 1000)).toContain('/1000x1000-000000-')
  })
})

describe('Pacer', () => {
  it('lets at most N calls through a minute, urgent ones first', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const p = new Pacer(2, () => now)
      const order: string[] = []
      await p.turn(false); order.push('a')
      await p.turn(false); order.push('b')
      expect(p.waitMs).toBe(60_000)
      const bg = p.turn(false).then(() => order.push('bg'))
      const urgent = p.turn(true).then(() => order.push('urgent'))
      now = 60_001
      await vi.advanceTimersByTimeAsync(61_000)
      await Promise.all([urgent, bg])
      // Both waited a minute; the urgent one, asked for later, went first.
      expect(order).toEqual(['a', 'b', 'urgent', 'bg'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lyrics', () => {
  it('parses LRC with several stamps per line and drops tags', () => {
    const lines = parseLrc('[ar:Someone]\n[00:12.50]First\n[00:20.00][01:00.00]Chorus\n[00:30.1]\n[00:31.00]After a gap')
    expect(lines).toEqual([
      { t: 12.5, text: 'First' }, { t: 20, text: 'Chorus' }, { t: 30.1, text: '' }, { t: 31, text: 'After a gap' }, { t: 60, text: 'Chorus' },
    ])
  })

  it('writes the lyrics picture script, shifted after a seek', () => {
    const lines = [{ t: 10, text: 'one {x}' }, { t: 20, text: 'two' }, { t: 30, text: 'three' }]
    const ass = lyricsAss({ lines, title: 'Song', artist: 'Singer', duration: 60, from: 15 })
    expect(ass).toContain('PlayResX: 1280')
    expect(ass).toContain('one (x)')
    // "one" (10–20 s) shows from 0 to 0:05 after a seek to 15 s; "three" starts at 0:15.
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,0:00:05\.00,Words.*\\fs50\\alpha&H00&\\b1\}one \(x\)/)
    expect(ass).toMatch(/Dialogue: 0,0:00:15\.00,0:00:45\.00,Words/)
    expect(lyricsAss({ lines: null, title: 'Song', artist: 'Singer', duration: 60, from: 0 })).toMatch(/\\fs60\}Song/)
  })
})

describe('engine', () => {
  const now = Date.UTC(2026, 10, 12)
  const a = track('Arijit Singh', 'Tum Hi Ho')
  const b = track('Arijit Singh', 'Channa Mereya')
  const c = track('Pritam', 'Gerua')
  const d = track('Badshah', 'Genda Phool')
  const history = [
    { trackId: a.id, artistId: a.artist.id, artist: 'Arijit Singh', credit: null, title: a.title, played: 260, outcome: 'complete' as const, at: now - 3600_000 },
    { trackId: b.id, artistId: b.artist.id, artist: 'Arijit Singh', credit: null, title: b.title, played: 270, outcome: 'complete' as const, at: now - 7200_000 },
    { trackId: d.id, artistId: d.artist.id, artist: 'Badshah', credit: null, title: d.title, played: 8, outcome: 'skip' as const, at: now - 3600_000 },
    { trackId: d.id, artistId: d.artist.id, artist: 'Badshah', credit: null, title: d.title, played: 5, outcome: 'skip' as const, at: now - 1800_000 },
  ]
  const ratings = { tracks: new Map([[c.id, 1]]), artists: new Map<string, number>() }

  it('learns artists from listens and likes, and blocks what was skipped twice', () => {
    const taste = buildTaste(history, ratings, [c], () => undefined, now)
    const seeds = seedArtists(taste, 3).map(s => s.name)
    expect(seeds.slice(0, 2).sort()).toEqual(['Arijit Singh', 'Pritam'])
    expect(seeds).not.toContain('Badshah')
    expect(score(taste, { track: d, fit: 1, why: '' }, { now, tasteWeight: 1 })).toBe(Number.NEGATIVE_INFINITY)
    // Just heard: pushed down against an equal song not heard.
    const fresh = track('Arijit Singh', 'Agar Tum Saath Ho')
    expect(score(taste, { track: a, fit: 0.5, why: '' }, { now, tasteWeight: 1 })).toBeLessThan(score(taste, { track: fresh, fit: 0.5, why: '' }, { now, tasteWeight: 1 }))
  })

  it('blocks a disliked artist completely', () => {
    const taste = buildTaste([], { tracks: new Map(), artists: new Map([[artistIdOf('Pritam'), -1]]) }, [], () => 'Pritam', now)
    expect(score(taste, { track: track('Pritam, Arijit Singh', 'Kesariya'), fit: 1, why: '' }, { now, tasteWeight: 1 })).toBe(Number.NEGATIVE_INFINITY)
  })

  it('arranges without crowding: a cap per artist and a gap between', () => {
    const list = [...Array(6)].map((_, i) => track('Arijit Singh', `Song ${i}`)).concat([track('Pritam', 'P1'), track('Shreya Ghoshal', 'S1')])
    const out = arrange(byPosition(list, () => '').map(x => ({ ...x, score: x.fit })), { size: 10, perArtist: 2, gap: 1 })
    const names = out.map(x => x.track.artist.name)
    expect(names.filter(n => n === 'Arijit Singh')).toHaveLength(2)
    for (let i = 1; i < names.length; i++) expect(names[i]).not.toBe(names[i - 1])
  })

  it('counts how listens end', () => {
    expect(outcomeOf(5, 200, 'skipped')).toBe('skip')
    expect(outcomeOf(5, 200, 'left')).toBeNull()
    expect(outcomeOf(170, 200, 'skipped')).toBe('complete')
    expect(outcomeOf(90, 200, 'skipped')).toBe('partial')
    expect(outcomeOf(3, 200, 'ended')).toBe('complete')
  })
})

describe('picking the YouTube upload', () => {
  const t = track('Coldplay', 'Yellow', { duration: 269 })
  it('takes the official audio, not a live take or a cover', () => {
    const list = [
      { id: 'aaaaaaaaaaa', title: 'Yellow (Live in Buenos Aires)', duration: 300, channel: 'Coldplay' },
      { id: 'bbbbbbbbbbb', title: 'Yellow', duration: 270, channel: 'Coldplay - Topic' },
      { id: 'ccccccccccc', title: 'Yellow (cover)', duration: 268, channel: 'Someone' },
    ]
    expect(pickUpload(t, list)?.id).toBe('bbbbbbbbbbb')
    expect(pickUpload(t, [{ id: 'ddddddddddd', title: 'Something Else', duration: 269 }])).toBeNull()
    expect(pickUpload(t, [{ id: 'eeeeeeeeeee', title: 'Yellow', duration: 400 }])).toBeNull()
  })
  it('prefers the official video for videos', () => {
    const list = [
      { id: 'bbbbbbbbbbb', title: 'Yellow', duration: 270, channel: 'Coldplay - Topic' },
      { id: 'fffffffffff', title: 'Coldplay - Yellow (Official Video)', duration: 272, channel: 'Coldplay' },
    ]
    expect(pickUpload(t, list, { video: true })?.id).toBe('fffffffffff')
  })
})

// ---- With a database and files ----------------------------------------------------------------------

let dir: string
let db: DatabaseSync
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexttupp-music-'))
  db = openDb(join(dir, 'nexttupp.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MusicStore', () => {
  it('fills gaps in what it knows about a song without replacing it', () => {
    const s = new MusicStore(db)
    s.saveTracks([{ ...track('Pritam', 'Gerua'), duration: 0 }])
    s.saveTracks([{ ...track('Pritam', 'Gerua'), title: 'Gerua (other)', duration: 345, album: { id: 'it9', title: 'Dilwale', cover: 'https://x/c.jpg' } }])
    expect(s.track(trackIdOf('Pritam', 'Gerua'))).toMatchObject({ title: 'Gerua', duration: 345, album: { id: 'it9', cover: 'https://x/c.jpg' } })
  })

  it('keeps likes and listens per profile', () => {
    const s = new MusicStore(db)
    const t = track('Pritam', 'Gerua')
    s.saveTracks([t])
    s.rate('p1', 'track', t.id, 1)
    expect(s.liked('p1').map(x => x.id)).toEqual([t.id])
    expect(s.liked('p2')).toEqual([])
    expect(s.listen('p1', t, 200, 'ended')).toBe('complete')
    expect(s.recent('p1', 5).map(x => x.id)).toEqual([t.id])
    s.rate('p1', 'track', t.id, 0)
    expect(s.likedCount('p1')).toBe(0)
  })
})

// A source that writes a few bytes instantly, and counts fetches.
class InstantSource implements AudioSource {
  readonly kind = 'fake' as const
  fetches = 0
  status () { return { helper: 'ok' as const } }
  async fetchAudio (t: MusicTrack, dest: string) {
    this.fetches++
    const { writeFileSync } = await import('node:fs')
    writeFileSync(dest, `audio ${t.id}`)
    return { ref: 'x', duration: 12 }
  }
  async fetchVideo () { return null }
}

describe('MusicFiles', () => {
  it('fetches a song once for two plays at the same time', async () => {
    const src = new InstantSource()
    const f = new MusicFiles({ db, dir: join(dir, 'music'), source: src, capBytes: 1e9 })
    const t = track('Pritam', 'Gerua')
    const [p1, p2] = await Promise.all([f.ensure(t, 'audio'), f.ensure(t, 'audio')])
    expect(p1).toBe(p2)
    expect(src.fetches).toBe(1)
    expect(f.saved(t.id, 'audio')?.duration).toBe(12)
    await expect(f.ensure(t, 'video')).rejects.toThrow(/no music video/)
  })

  it('removes the least recently played when over the limit', async () => {
    let now = 1000
    const f = new MusicFiles({ db, dir: join(dir, 'music'), source: new InstantSource(), capBytes: 70, now: () => now })
    const list = ['A', 'B', 'C', 'D'].map(n => track('X', n))
    for (const t of list) { now += 10; await f.ensure(t, 'audio') }
    expect(f.saved(list[0].id, 'audio')).toBeNull()
    expect(f.saved(list[3].id, 'audio')).not.toBeNull()
  })
})

// ---- Casting to a stand-in TV -------------------------------------------------------------------------

class StandInTv extends EventEmitter {
  loads: LoadRequest[] = []
  closed = false
  status: MediaStatus = { mediaSessionId: 1, playerState: 'IDLE', currentTime: 0 }
  async launch () {}
  async load (r: LoadRequest) { this.loads.push(r); this.status = { mediaSessionId: 1, playerState: 'PLAYING', currentTime: r.currentTime }; return this.status }
  async play () { this.status = { ...this.status, playerState: 'PLAYING' }; return this.status }
  async pause () { this.status = { ...this.status, playerState: 'PAUSED' }; return this.status }
  async seek (t: number) { this.status = { ...this.status, currentTime: t }; return this.status }
  async getStatus () { return this.status }
  async setVolume () {}
  async stopApp () { this.closed = true }
  close () { this.closed = true }
  finish () { this.status = { mediaSessionId: 1, playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0 }; this.emit('media', this.status) }
  appSession = 'APP-1'
  mediaSessionId = 1
  /** What joining this TV's player finds: its status, nothing playing (null), or the player gone (false). */
  joins: MediaStatus | null | false = null
  async join () { return this.joins === false ? null : { status: this.joins } }
  drop () { this.closed = true; this.emit('close') }
}

describe('MusicCast', () => {
  it('plays through the queue on its own and hands each song to the TV only', async () => {
    const store = new MusicStore(db)
    const songs = [track('Pritam', 'Gerua'), track('Arijit Singh', 'Tum Hi Ho'), track('Shreya Ghoshal', 'Teri Ore')]
    store.saveTracks(songs)
    const files = new MusicFiles({ db, dir: join(dir, 'music'), source: new InstantSource(), capBytes: 1e9 })
    const tv = new StandInTv()
    const device: CastDevice = { id: 'tv', name: 'Living room', host: '192.168.1.50', port: 8009 } as CastDevice
    let filmStopped = 0
    const cast = new MusicCast({
      discovery: { get: () => device } as unknown as CastDiscovery,
      lan: { holdForCast: () => () => {}, refresh: async () => {}, addressFor: async () => '192.168.1.10', port: 4545 },
      files,
      track: id => store.track(id),
      lyrics: true,
      beforeStart: async () => { filmStopped++ },
      connect: async () => tv as unknown as MediaReceiver,
      pollMs: 60_000,
    })
    const s = await cast.start({ deviceId: 'tv', queue: songs.map(t => t.id), index: 0, t: 0, mode: 'audio' })
    expect(filmStopped).toBe(1)
    expect(s).toMatchObject({ active: true, index: 0, mode: 'audio' })
    expect(tv.loads[0]).toMatchObject({ contentType: 'audio/mp4', title: 'Gerua', music: { artist: 'Pritam' } })
    const token = tv.loads[0].contentId.match(/\/cast\/m\/([^/]+)\/audio\.m4a$/)![1]
    expect(cast.verify(token, '192.168.1.50')?.trackId).toBe(songs[0].id)
    expect(cast.verify(token, '192.168.1.77')).toBeNull()

    tv.finish()
    await new Promise(r => setTimeout(r, 50))
    expect(tv.loads).toHaveLength(2)
    expect(cast.status().index).toBe(1)

    // Lyrics from where it is: a picture that starts its own clock there.
    await cast.control('mode', { mode: 'lyrics' })
    expect(tv.loads[2].contentId).toMatch(/\/lyrics\.mp4$/)
    await cast.control('seek', { t: 30 })
    const g = cast.verify(tv.loads[3].contentId.split('/')[5], '192.168.1.50')
    expect(g).toMatchObject({ mode: 'lyrics', from: 11 })

    await cast.control('next', {})
    expect(cast.status().index).toBe(2)
    tv.finish()
    await new Promise(r => setTimeout(r, 50))
    expect(cast.status()).toMatchObject({ active: false, state: 'ended' })
  })
})

describe('Set up music (downloading yt-dlp)', () => {
  const NAMES = ['yt-dlp_linux', 'yt-dlp_linux_aarch64', 'yt-dlp_macos', 'yt-dlp.exe', 'yt-dlp_arm64.exe', 'yt-dlp_x86.exe']
  const helper = Buffer.from('#!/bin/sh\necho yt-dlp\n'.repeat(500))
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nexttupp-ytdlp-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A release server: the sums file, and the helper sent in slow pieces (or stalling after the first). */
  const release = (opts: { sum?: string; stall?: boolean }) => (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/SHA2-256SUMS')) {
      const sum = opts.sum ?? createHash('sha256').update(helper).digest('hex')
      return new Response(NAMES.map(n => `${sum}  ${n}`).join('\n'))
    }
    const parts = [helper.subarray(0, 4000), helper.subarray(4000)]
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      async pull (ctl) {
        if (opts.stall && i === 1) {
          await new Promise((resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
        }
        await new Promise(resolve => setTimeout(resolve, 5))
        if (i < parts.length) ctl.enqueue(new Uint8Array(parts[i++])); else ctl.close()
      },
    })
    return new Response(body, { headers: { 'content-length': String(helper.length) } })
  }) as typeof fetch

  it('downloads with progress, checks the checksum and installs the helper', async () => {
    const src = new YoutubeSource({ dataDir: dir, ffmpeg: 'ffmpeg', fetch: release({}), stallMs: 1000 })
    const going = src.install()
    const seen: number[] = []
    while (src.status().helper === 'installing') {
      const p = src.status().progress
      if (p !== undefined) seen.push(p)
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    await going
    expect(src.status().helper).toBe('ok')
    expect(existsSync(join(dir, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'))).toBe(true)
    expect(seen.some(p => p > 0 && p < 1)).toBe(true)
  })

  it('gives up only when the download stalls, and says so', async () => {
    const src = new YoutubeSource({ dataDir: dir, ffmpeg: 'ffmpeg', fetch: release({ stall: true }), stallMs: 50 })
    await expect(src.install()).rejects.toThrow(/stalled/)
    expect(src.status()).toMatchObject({ helper: 'error', message: expect.stringMatching(/stalled/) })
  })

  it('refuses a helper that doesn’t match the published checksum', async () => {
    const src = new YoutubeSource({ dataDir: dir, ffmpeg: 'ffmpeg', fetch: release({ sum: 'a'.repeat(64) }), stallMs: 1000 })
    await expect(src.install()).rejects.toThrow(/checksum/)
    expect(existsSync(join(dir, 'bin'))).toBe(false)
  })
})

describe('MusicCast and a dropped connection', () => {
  it('joins the TV again; a song that ended meanwhile goes on to the next', async () => {
    const store = new MusicStore(db)
    const songs = [track('Diljit Dosanjh', 'Lover'), track('AP Dhillon', 'Excuses'), track('Karan Aujla', 'Softly')]
    store.saveTracks(songs)
    const files = new MusicFiles({ db, dir: join(dir, 'music'), source: new InstantSource(), capBytes: 1e9 })
    const tvs = [new StandInTv(), new StandInTv(), new StandInTv()]
    let made = 0
    const device: CastDevice = { id: 'tv', name: 'Kitchen TV', host: '192.168.1.40', port: 8009 } as CastDevice
    const cast = new MusicCast({
      discovery: { get: () => device } as unknown as CastDiscovery,
      lan: { holdForCast: () => () => {}, refresh: async () => {}, addressFor: async () => '192.168.1.10', port: 4545 },
      files,
      track: id => store.track(id),
      lyrics: false,
      connect: async () => tvs[made++] as unknown as MediaReceiver,
      pollMs: 60_000,
      rejoinDelays: [0, 10],
    })
    await cast.start({ deviceId: 'tv', queue: songs.map(t => t.id), index: 0, t: 0, mode: 'audio' })
    // Still playing on the TV: joined again, nothing reloads.
    tvs[1].joins = { mediaSessionId: 1, playerState: 'PLAYING', currentTime: 7 }
    tvs[0].drop()
    await new Promise(r => setTimeout(r, 20))
    expect(cast.status()).toMatchObject({ active: true, index: 0, state: 'playing' })
    expect(cast.status().position).toBeGreaterThanOrEqual(7)
    expect(tvs[1].loads).toHaveLength(0)
    // The song finished while the connection was down: the next one plays.
    tvs[2].joins = null
    tvs[1].drop()
    await new Promise(r => setTimeout(r, 30))
    expect(cast.status()).toMatchObject({ active: true, index: 1 })
    expect(tvs[2].loads[0]).toMatchObject({ title: 'Excuses' })
    // Taps on the phone go to the new connection.
    await cast.control('pause', {})
    expect(tvs[2].status.playerState).toBe('PAUSED')
    await cast.stop()
  })
})
