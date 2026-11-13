import { mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MediaType, TrailerStatus } from '../shared/types.ts'
import { HttpError } from './http.ts'
import { sendFile } from './music/routes.ts'
import { run } from './music/source.ts'
import type { YoutubeSource } from './music/youtube.ts'
import { hasPrivateHeader } from './private.ts'

// Trailers behind the title page's hero and the home billboard (docs/adr/0011). A title's trailers are YouTube
// videos Cinemeta lists; the computer downloads one with the music helper (yt-dlp, server/music/youtube.ts),
// at most 720p and 5 minutes, and keeps it in data/trailers (1 GB, least recently shown go first). On a slow
// line the first download takes minutes, so the page asks, gets "preparing", and asks again for a while; the
// next visit plays at once. Without the helper, or in private mode for a trailer not saved yet, there's none.
//
//   GET       /api/trailer/:type/:id         TrailerStatus
//   GET       /api/trailer/:type/:id/search  { ids }: YouTube ids found by searching (the quick-view popup)
//   GET/HEAD  /api/trailer/video/:ytId       the saved MP4 (ranges)

const YT_ID = /^[\w-]{11}$/
const DAY = 24 * 3600_000
const FILE = /^[\w-]{11}\.mp4$/
const IMDB_ID = /^tt\d{1,10}$/

export interface TrailerSource {
  /** Whether trailers can be fetched now (the helper is on this computer). */
  ready (): boolean
  /** Saves YouTube video `ytId` as MP4 (H.264 + AAC, at most 720p) at `dest`; fails if it's longer than `maxSeconds`. */
  save (ytId: string, dest: string, maxSeconds: number): Promise<void>
}

/** The real source: the music tab's yt-dlp. */
export const youtubeTrailers = (yt: YoutubeSource): TrailerSource => ({
  ready: () => yt.binary() !== null,
  save: async (ytId, dest, maxSeconds) => { await yt.saveVideo(ytId, dest, maxSeconds) },
})

/** A test pattern made by ffmpeg instead of YouTube, for tests and demos (NEXTTUPP_TRAILER_SOURCE=fake). */
export class FakeTrailerSource implements TrailerSource {
  private readonly ffmpeg: string
  private readonly seconds: number
  private readonly size: string

  constructor (ffmpeg: string, opts: { seconds?: number; size?: string } = {}) {
    this.ffmpeg = ffmpeg
    this.seconds = opts.seconds ?? 12
    this.size = opts.size ?? '1280x720'
  }

  ready (): boolean { return true }

  async save (_ytId: string, dest: string): Promise<void> {
    const d = this.seconds
    await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${this.size}:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${d}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', '-f', 'mp4', dest], { timeoutMs: 120_000 })
  }
}

export interface TrailerOptions {
  /** Where trailers are kept (data/trailers). */
  dir: string
  source: TrailerSource
  /** The title's trailers, as YouTube ids, best first. */
  lookup: (type: MediaType, id: string) => Promise<string[]>
  /** More trailers, found by searching YouTube for the title (for the quick view, when Cinemeta's don't play). */
  search?: (type: MediaType, id: string) => Promise<string[]>
  /** Total size kept, in bytes. */
  capBytes?: number
  /** Downloads at once. One: on a slow line, two would each take twice as long. */
  parallel?: number
  /** Longer videos aren't trailers (or are too big to fetch for this). */
  maxSeconds?: number
  /** A waiting download nobody has asked about for this long is dropped: its page was left. */
  staleMs?: number
  /** A trailer that couldn't be fetched isn't tried again for this long. */
  retryMs?: number
  log?: (msg: string) => void
  now?: () => number
}

export class Trailers {
  private readonly o: Required<TrailerOptions>
  /** Waiting downloads: YouTube id → when a page last asked for it. */
  private readonly queue = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly failed = new Map<string, number>()
  /** Search results by title, kept a day: searching takes yt-dlp a few seconds. */
  private readonly found = new Map<string, { at: number; ids: Promise<string[]> }>()

  constructor (opts: TrailerOptions) {
    this.o = { search: async () => [], capBytes: 1e9, parallel: 1, maxSeconds: 300, staleMs: 60_000, retryMs: 3600_000, log: () => {}, now: Date.now, ...opts }
    mkdirSync(this.o.dir, { recursive: true })
    // Leftovers of downloads cut short by a restart.
    for (const f of readdirSync(this.o.dir)) if (!FILE.test(f)) rmSync(join(this.o.dir, f), { recursive: true, force: true })
  }

  private file (ytId: string): string { return join(this.o.dir, `${ytId}.mp4`) }

  /** The saved trailer's path, or null. */
  saved (ytId: string): string | null {
    if (!YT_ID.test(ytId)) return null
    const path = this.file(ytId)
    try { return statSync(path).isFile() ? path : null } catch { return null }
  }

  /** Whether a download of this is running or waiting. */
  busy (ytId: string): boolean { return this.running.has(ytId) || this.queue.has(ytId) }

  async status (type: MediaType, id: string, opts: { private?: boolean } = {}): Promise<TrailerStatus> {
    const ids = (await this.o.lookup(type, id).catch(() => [])).filter(x => YT_ID.test(x)).slice(0, 3)
    for (const yt of ids) {
      if (!this.saved(yt)) continue
      if (!opts.private) this.touch(yt)
      return { state: 'ready', url: `/api/trailer/video/${yt}` }
    }
    // Private mode keeps nothing, so it starts no download (the file would be a record of what was looked at).
    if (opts.private || !this.o.source.ready()) return { state: 'none' }
    const now = this.o.now()
    // The first that hasn't failed lately: an old trailer's video is sometimes gone from YouTube.
    const yt = ids.find(x => now - (this.failed.get(x) ?? -Infinity) >= this.o.retryMs)
    if (!yt) return { state: 'none' }
    if (!this.running.has(yt)) {
      this.queue.set(yt, now)
      this.pump()
    }
    return { state: 'preparing' }
  }

  /** YouTube ids from a search for this title's trailer; none when the helper isn't set up or it fails. */
  search (type: MediaType, id: string): Promise<string[]> {
    const key = `${type}/${id}`
    const now = this.o.now()
    const hit = this.found.get(key)
    if (hit && now - hit.at < DAY) return hit.ids
    const ids = this.o.search(type, id)
      .then(list => list.filter(x => YT_ID.test(x)).slice(0, 5))
      .catch(err => { this.o.log(`trailers: search for ${key} failed: ${(err as Error).message}`); this.found.delete(key); return [] })
    this.found.delete(key)
    this.found.set(key, { at: now, ids })
    if (this.found.size > 500) this.found.delete(this.found.keys().next().value!)
    return ids
  }

  /** Starts waiting downloads while there's room, the one asked about last first (the page on screen now). */
  private pump (): void {
    const now = this.o.now()
    for (const [yt, at] of this.queue) if (now - at > this.o.staleMs) this.queue.delete(yt)
    while (this.running.size < this.o.parallel && this.queue.size) {
      const [yt] = [...this.queue].reduce((a, b) => (b[1] >= a[1] ? b : a))
      this.queue.delete(yt)
      this.running.add(yt)
      void this.fetch(yt).finally(() => { this.running.delete(yt); this.pump() })
    }
  }

  private async fetch (yt: string): Promise<void> {
    const dest = this.file(yt)
    const part = join(this.o.dir, `${yt}.part.mp4`)
    const began = this.o.now()
    try {
      await this.o.source.save(yt, part, this.o.maxSeconds)
      renameSync(part, dest)
      this.touch(yt)
      this.o.log(`trailers: saved one in ${((this.o.now() - began) / 1000).toFixed(1)} s (${(statSync(dest).size / 1e6).toFixed(1)} MB)`)
      this.evict(yt)
    } catch (err) {
      rmSync(part, { force: true })
      this.failed.set(yt, this.o.now())
      if (this.failed.size > 500) this.failed.delete(this.failed.keys().next().value!)
      this.o.log(`trailers: couldn’t get one: ${(err as Error).message}`)
    }
  }

  /** Marks a trailer as just shown (the file's time), for the least-recently-shown order. */
  private touch (yt: string): void {
    const t = this.o.now() / 1000
    try { utimesSync(this.file(yt), t, t) } catch { /* gone */ }
  }

  /** Least recently shown first, until the folder fits (never the one just saved). */
  private evict (keep: string): void {
    const files = readdirSync(this.o.dir).filter(f => FILE.test(f)).flatMap(f => {
      try { const s = statSync(join(this.o.dir, f)); return [{ f, bytes: s.size, at: s.mtimeMs }] } catch { return [] }
    }).sort((a, b) => a.at - b.at)
    let total = files.reduce((n, x) => n + x.bytes, 0)
    for (const x of files) {
      if (total <= this.o.capBytes) break
      if (x.f === `${keep}.mp4`) continue
      // On Windows a file being played can't be deleted; it goes next time.
      try { rmSync(join(this.o.dir, x.f)); total -= x.bytes } catch { /* in use */ }
    }
  }
}

export function registerTrailerRoutes (app: FastifyInstance, trailers: Trailers): void {
  app.get<{ Params: { type: string; id: string } }>('/api/trailer/:type/:id', async (req): Promise<TrailerStatus> => {
    const { type, id } = req.params
    if ((type !== 'movie' && type !== 'series') || !IMDB_ID.test(id)) throw new HttpError(400, 'Bad title id')
    return trailers.status(type, id, { private: hasPrivateHeader(req) })
  })

  // The quick view's fallback: Cinemeta's trailers didn't play. Searching saves nothing, so private mode can too.
  app.get<{ Params: { type: string; id: string } }>('/api/trailer/:type/:id/search', async (req): Promise<{ ids: string[] }> => {
    const { type, id } = req.params
    if ((type !== 'movie' && type !== 'series') || !IMDB_ID.test(id)) throw new HttpError(400, 'Bad title id')
    return { ids: await trailers.search(type, id) }
  })

  const video = async (req: FastifyRequest<{ Params: { ytId: string } }>, reply: FastifyReply) => {
    const path = trailers.saved(req.params.ytId)
    if (!path) throw new HttpError(404, 'Not found')
    // Not kept in the browser's cache: it's on this computer, and private mode leaves no copy.
    return sendFile(req, reply, path, 'video/mp4', { 'cache-control': 'no-store' })
  }
  app.get('/api/trailer/video/:ytId', video)
  app.head('/api/trailer/video/:ytId', video)
}
