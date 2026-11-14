import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WatchedCleanup } from './cleanup.ts'
import { Library } from './library.ts'
import type { TorrentEngine } from './engine/engine.ts'

const MOVIE = 'a'.repeat(40)
const PACK = 'b'.repeat(40)
const PIECE = 1024
const HOUR = 3600_000

interface FakeSession {
  id: string; infoHash: string; streamId?: string; title?: string; pinned: boolean
  file: { path: string; name: string }; torrent: { pieceLength: number }
}

/** Just enough engine for the cleanup and the library: sessions, "in use", and unload. */
function fakeEngine () {
  const sessions: FakeSession[] = []
  const busy = new Set<string>()
  const privateIds = new Set<string>()
  const unloaded: string[] = []
  const opened: Array<number | undefined> = []
  const engine = {
    list: () => sessions,
    get: (id: string) => sessions.find(s => s.id === id),
    isPrivate: (id: string) => privateIds.has(id),
    inUse: (h: string) => busy.has(h),
    async unload (h: string) {
      unloaded.push(h)
      for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].infoHash === h) sessions.splice(i, 1)
    },
    async open (req: { fileIdx?: number }) { opened.push(req.fileIdx); return new Promise(() => {}) },
    pin (s: FakeSession) { s.pinned = true },
    unpin (s: FakeSession) { s.pinned = false },
    async abandon () {},
    async close () {},
  }
  const open = (infoHash: string, idx: number, path: string, streamId?: string, title?: string) => {
    const s: FakeSession = { id: `${infoHash}-${idx}`, infoHash, streamId, title, pinned: false, file: { path, name: path.split('/').at(-1)! }, torrent: { pieceLength: PIECE } }
    sessions.push(s)
    return s
  }
  return { engine: engine as unknown as TorrentEngine, sessions, busy, privateIds, unloaded, opened, open }
}

function setup () {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-'))
  const f = fakeEngine()
  const library = new Library(dir, f.engine)
  const logs: string[] = []
  let tv: string | undefined
  let offset = 0
  const make = () => new WatchedCleanup({ dataDir: dir, engine: f.engine, library, casting: () => tv, log: m => logs.push(m), now: () => Date.now() + offset })
  /** Writes `bytes` of a torrent's file into the downloads folder. */
  const put = (infoHash: string, path: string, bytes: number) => {
    const p = join(dir, 'downloads', infoHash, path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, Buffer.alloc(bytes, 1))
    return p
  }
  const saved = (infoHash: string) => {
    mkdirSync(join(dir, 'torrents'), { recursive: true })
    writeFileSync(join(dir, 'torrents', `${infoHash}.torrent`), 'd4:infoe')
    return join(dir, 'torrents', `${infoHash}.torrent`)
  }
  /** Moves the cleanup's clock on. */
  const later = (hours: number) => { offset += hours * HOUR }
  return { dir, f, library, logs, make, put, saved, later, now: () => Date.now() + offset, cast: (id: string | undefined) => { tv = id } }
}

describe('WatchedCleanup: watched films and episodes are deleted', () => {
  it('deletes a watched film once nothing is playing it, then its torrent folder and metadata', async () => {
    const t = setup()
    const cleanup = t.make()
    const film = t.put(MOVIE, 'Dune.2021.mkv', 50_000)
    t.put(MOVIE, 'Dune.2021.nfo', 300)
    const meta = t.saved(MOVIE)
    t.f.open(MOVIE, 0, 'Dune.2021.mkv', 'tt1160419', 'Dune')
    t.f.busy.add(MOVIE) // still on the credits

    await cleanup.finished('tt1160419')
    await cleanup.sweep()
    expect(existsSync(film)).toBe(true)
    expect(cleanup.pending().map(w => w.id)).toEqual([`${MOVIE}-0`])

    t.f.busy.delete(MOVIE) // the player went idle
    await cleanup.sweep()
    expect(t.f.unloaded).toEqual([MOVIE])
    expect(existsSync(film)).toBe(false)
    expect(existsSync(join(t.dir, 'downloads', MOVIE))).toBe(false)
    expect(existsSync(meta)).toBe(false)
    expect(cleanup.pending()).toEqual([])
    expect(t.logs).toEqual(['watched, so deleted: Dune (1 MB freed, torrent removed)'])
  })

  it('waits while the film plays on a TV', async () => {
    const t = setup()
    const cleanup = t.make()
    const film = t.put(MOVIE, 'Dune.2021.mkv', 50_000)
    t.f.open(MOVIE, 0, 'Dune.2021.mkv', 'tt1160419', 'Dune')
    t.cast(`${MOVIE}-0`)
    await cleanup.finished('tt1160419')
    await cleanup.sweep()
    expect(existsSync(film)).toBe(true)
    t.cast(undefined)
    await cleanup.sweep()
    expect(existsSync(film)).toBe(false)
  })

  it('season pack: deletes only the watched episode, and the torrent once nothing else in it has data', async () => {
    const t = setup()
    const cleanup = t.make()
    const e1 = t.put(PACK, 'Show S01/Show.S01E01.mkv', 40_000)
    const e2 = t.put(PACK, 'Show S01/Show.S01E02.mkv', 40_000) // started, not finished
    const e3 = t.put(PACK, 'Show S01/Show.S01E03.mkv', 1_000) // only the edge piece E02's streaming wrote
    const meta = t.saved(PACK)
    t.f.open(PACK, 0, 'Show S01/Show.S01E01.mkv', 'tt1:1:1', 'Show · S1E1')
    t.f.open(PACK, 1, 'Show S01/Show.S01E02.mkv', 'tt1:1:2', 'Show · S1E2')

    await cleanup.finished('tt1:1:1')
    await cleanup.sweep()
    expect(existsSync(e1)).toBe(false)
    expect(existsSync(e2)).toBe(true)
    expect(existsSync(e3)).toBe(true)
    expect(existsSync(meta)).toBe(true)
    expect(t.logs).toEqual(['watched, so deleted: Show · S1E1 (1 MB freed)'])

    t.f.open(PACK, 1, 'Show S01/Show.S01E02.mkv', 'tt1:1:2', 'Show · S1E2')
    await cleanup.finished('tt1:1:2')
    await cleanup.sweep()
    expect(existsSync(join(t.dir, 'downloads', PACK))).toBe(false)
    expect(existsSync(meta)).toBe(false)
  })

  it('a kept download leaves the Downloads list at once and its file goes when idle; one beside it carries on', async () => {
    const t = setup()
    const cleanup = t.make()
    const base = { infoHash: PACK, type: 'series' as const, imdbId: 'tt1', addedAt: 1 }
    t.library.add({ ...base, id: `${PACK}-0`, fileIdx: 0, fileName: 'Show.S01E01.mkv', title: 'Show · S1E1', streamId: 'tt1:1:1' })
    t.library.add({ ...base, id: `${PACK}-1`, fileIdx: 1, fileName: 'Show.S01E02.mkv', title: 'Show · S1E2', streamId: 'tt1:1:2' })
    const e1 = t.put(PACK, 'Show S01/Show.S01E01.mkv', 40_000)
    const e2 = t.put(PACK, 'Show S01/Show.S01E02.mkv', 500) // just started downloading
    const s1 = t.f.open(PACK, 0, 'Show S01/Show.S01E01.mkv', 'tt1:1:1')
    s1.pinned = true
    t.f.open(PACK, 1, 'Show S01/Show.S01E02.mkv', 'tt1:1:2').pinned = true
    t.f.busy.add(PACK)

    await cleanup.finished('tt1:1:1')
    expect(t.library.list().map(e => e.id)).toEqual([`${PACK}-1`])
    expect(s1.pinned).toBe(false) // stopped downloading
    await cleanup.sweep()
    expect(existsSync(e1)).toBe(true)

    t.f.busy.delete(PACK)
    await cleanup.sweep()
    expect(existsSync(e1)).toBe(false)
    expect(existsSync(e2)).toBe(true) // still kept, so the torrent stays even with little data yet
    expect(t.f.opened).toEqual([1]) // and its download was started again
  })

  it('finds a kept download that was not open by its file name', async () => {
    const t = setup()
    const cleanup = t.make()
    t.library.add({ id: `${MOVIE}-0`, infoHash: MOVIE, fileIdx: 0, fileName: 'Dune.2021.mkv', title: 'Dune', type: 'movie', imdbId: 'tt1160419', streamId: 'tt1160419', addedAt: 1 })
    const film = t.put(MOVIE, 'Dune (2021)/Dune.2021.mkv', 50_000)
    await cleanup.finished('tt1160419')
    expect(t.library.list()).toEqual([])
    await cleanup.sweep()
    expect(existsSync(film)).toBe(false)
  })

  it('leaves titles that were not finished, private sessions, and a file kept again after watching', async () => {
    const t = setup()
    const cleanup = t.make()
    const film = t.put(MOVIE, 'Dune.2021.mkv', 50_000)
    const ep = t.put(PACK, 'Show.S01E01.mkv', 50_000)
    t.f.open(MOVIE, 0, 'Dune.2021.mkv', 'tt1160419', 'Dune')
    t.f.open(PACK, 0, 'Show.S01E01.mkv', 'tt1:1:1')
    t.f.privateIds.add(`${PACK}-0`)

    await cleanup.finished('tt1:1:1') // private: its own cleanup deletes it
    await cleanup.finished('tt9999999') // nothing open of it
    expect(cleanup.pending()).toEqual([])

    await cleanup.finished('tt1160419')
    t.library.add({ id: `${MOVIE}-0`, infoHash: MOVIE, fileIdx: 0, fileName: 'Dune.2021.mkv', title: 'Dune', type: 'movie', imdbId: 'tt1160419', streamId: 'tt1160419', addedAt: Date.now() + 1 })
    await cleanup.sweep()
    expect(existsSync(film)).toBe(true)
    expect(existsSync(ep)).toBe(true)
    expect(cleanup.pending()).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('retries a failed delete later, after a restart too', async () => {
    const t = setup()
    const film = t.put(MOVIE, 'Dune (2021)/Dune.2021.mkv', 50_000)
    const folder = dirname(film)
    t.f.open(MOVIE, 0, 'Dune (2021)/Dune.2021.mkv', 'tt1160419', 'Dune')
    await t.make().finished('tt1160419')

    chmodSync(folder, 0o555) // like a file Windows still has open
    const cleanup = t.make() // after a restart
    try {
      await cleanup.sweep()
      await cleanup.sweep()
    } finally {
      chmodSync(folder, 0o755)
    }
    expect(existsSync(film)).toBe(true)
    expect(t.logs.filter(l => l.includes('could not delete Dune yet'))).toHaveLength(1)

    await cleanup.sweep()
    expect(existsSync(film)).toBe(false)
    expect(cleanup.pending()).toEqual([])
  })
})

describe('WatchedCleanup: what is not played goes too', () => {
  const OTHER = 'c'.repeat(40)
  const KEPT = 'd'.repeat(40)

  it('deletes streamed data not played for a day, not before, and never what is kept or playing', async () => {
    const t = setup()
    const cleanup = t.make()
    const film = t.put(MOVIE, 'Dune.2021.mkv', 50_000)
    const meta = t.saved(MOVIE)
    cleanup.touch(MOVIE, 'Dune')
    const old = t.put(PACK, 'Show.S01E01.mkv', 50_000) // streamed before this was recorded: its files' time counts
    const playing = t.put(OTHER, 'Heat.1995.mkv', 50_000)
    const kept = t.put(KEPT, 'Alien.1979.mkv', 50_000)
    t.library.add({ id: `${KEPT}-0`, infoHash: KEPT, fileIdx: 0, fileName: 'Alien.1979.mkv', title: 'Alien', type: 'movie', imdbId: 'tt0078748', streamId: 'tt0078748', addedAt: Date.now() })

    t.later(23)
    await cleanup.sweep()
    expect([film, old, playing, kept].every(existsSync)).toBe(true)

    t.later(2)
    t.f.busy.add(OTHER)
    await cleanup.sweep()
    expect(existsSync(film)).toBe(false)
    expect(existsSync(meta)).toBe(false)
    expect(existsSync(join(t.dir, 'downloads', MOVIE))).toBe(false)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(playing)).toBe(true)
    expect(existsSync(kept)).toBe(true)
    expect(t.logs).toContain('not played for a day, so deleted: Dune (1 MB freed)')
    expect(t.logs.some(l => l.includes('Show S01E01'))).toBe(true)
    expect(t.f.unloaded).toEqual(expect.arrayContaining([MOVIE, PACK]))

    // Played again (after a restart, from what was recorded): another day from then.
    t.f.busy.delete(OTHER)
    const again = t.make()
    again.touch(OTHER, 'Heat')
    await again.sweep()
    t.later(23)
    await t.make().sweep()
    expect(existsSync(playing)).toBe(true)
  })

  it('a download kept for later goes after 30 days not played; playing it starts the 30 days again', async () => {
    const t = setup()
    const cleanup = t.make()
    t.library.add({ id: `${KEPT}-0`, infoHash: KEPT, fileIdx: 0, fileName: 'Alien.1979.mkv', title: 'Alien', type: 'movie', imdbId: 'tt0078748', streamId: 'tt0078748', addedAt: 1 })
    const file = t.put(KEPT, 'Alien.1979.mkv', 50_000)
    t.saved(KEPT)

    await cleanup.sweep() // kept before this rule: its 30 days start now
    t.later(29 * 24)
    cleanup.touch(KEPT) // watched a bit
    t.later(29 * 24)
    await cleanup.sweep()
    expect(t.library.list()).toHaveLength(1)
    expect(existsSync(file)).toBe(true)

    t.later(2 * 24)
    await cleanup.sweep()
    expect(t.library.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(t.dir, 'downloads', KEPT))).toBe(false)
    expect(t.logs).toContain('not played for 30 days, so deleted: Alien (1 MB freed, torrent removed)')
  })

  it('kept forever: stays unplayed and after watching; letting it go gives it 30 days from then', async () => {
    const t = setup()
    const cleanup = t.make()
    const id = `${KEPT}-0`
    t.library.add({ id, infoHash: KEPT, fileIdx: 0, fileName: 'Alien.1979.mkv', title: 'Alien', type: 'movie', imdbId: 'tt0078748', streamId: 'tt0078748', addedAt: 1 })
    const file = t.put(KEPT, 'Alien.1979.mkv', 50_000)
    t.f.open(KEPT, 0, 'Alien.1979.mkv', 'tt0078748', 'Alien')
    await cleanup.sweep()
    expect(cleanup.expiresAt(t.library.get(id)!)! - t.now()).toBeCloseTo(30 * 24 * HOUR, -2)

    t.library.setForever(id, true)
    expect(cleanup.expiresAt(t.library.get(id)!)).toBeNull()
    t.later(30 * 24)
    await cleanup.finished('tt0078748') // watched to the end
    await cleanup.sweep()
    expect(cleanup.pending()).toEqual([])
    expect(t.library.list()).toHaveLength(1)
    expect(existsSync(file)).toBe(true)

    t.library.setForever(id, false, t.now())
    await cleanup.sweep()
    expect(t.library.list()).toHaveLength(1) // not straight away: 30 days from now
    expect(cleanup.expiresAt(t.library.get(id)!)! - t.now()).toBeCloseTo(30 * 24 * HOUR, -2)
    t.later(30 * 24)
    await cleanup.sweep()
    expect(t.library.list()).toEqual([])
  })

  it('a kept download that is playing is not taken away', async () => {
    const t = setup()
    const cleanup = t.make()
    t.library.add({ id: `${KEPT}-0`, infoHash: KEPT, fileIdx: 0, fileName: 'Alien.1979.mkv', title: 'Alien', type: 'movie', imdbId: 'tt0078748', streamId: 'tt0078748', addedAt: 1 })
    const file = t.put(KEPT, 'Alien.1979.mkv', 50_000)
    await cleanup.sweep()
    t.later(15 * 24)
    const s = t.f.open(KEPT, 0, 'Alien.1979.mkv', 'tt0078748', 'Alien') as { activeStreams?: number }
    s.activeStreams = 1 // on the TV right now
    t.f.busy.add(KEPT)
    await cleanup.sweep()
    expect(t.library.list()).toHaveLength(1)
    expect(existsSync(file)).toBe(true)
  })
})

describe('WatchedCleanup: the Storage page', () => {
  it('lists what streaming left (not what is kept), and deletes one now unless it is playing or kept', async () => {
    const t = setup()
    const cleanup = t.make()
    t.put(MOVIE, 'Dune.Part.Two.2024.mkv', 40_000)
    t.saved(MOVIE)
    cleanup.touch(MOVIE, 'Dune: Part Two')
    t.put(PACK, 'Show.S01E01.mkv', 10_000)
    t.library.add({ id: `${PACK}-0`, infoHash: PACK, fileIdx: 0, fileName: 'Show.S01E01.mkv', title: 'Show · S1E1', type: 'series', imdbId: 'tt1', streamId: 'tt1:1:1', addedAt: Date.now() })

    const listed = await cleanup.streamed()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ infoHash: MOVIE, title: 'Dune: Part Two', inUse: false })
    expect(listed[0].bytes).toBeGreaterThanOrEqual(40_000)

    expect(await cleanup.remove(PACK)).toBeNull() // kept: Downloads deletes it
    t.f.busy.add(MOVIE)
    expect(await cleanup.remove(MOVIE)).toBeNull() // playing
    t.f.busy.delete(MOVIE)
    expect(await cleanup.remove(MOVIE)).toMatchObject({ title: 'Dune: Part Two' })
    expect(existsSync(join(t.dir, 'downloads', MOVIE))).toBe(false)
    expect(existsSync(join(t.dir, 'torrents', `${MOVIE}.torrent`))).toBe(false)
    expect(await cleanup.streamed()).toEqual([])
  })
})
