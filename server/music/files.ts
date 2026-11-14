import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { MusicTrack } from '../../shared/music.ts'
import type { AudioSource } from './source.ts'

// Songs (and music videos) saved on this computer, in data/music/{audio,video}. A song is fetched the first
// time it's played (or when it's next in the queue) and kept until the folder is over its size limit; then
// the least recently played go first.

export type FileKind = 'audio' | 'video'

const RETRY_AFTER_MS = 10 * 60_000
/** A song played (or queued) this recently may still be playing somewhere; clearing leaves it. */
const IN_USE_MS = 10 * 60_000

export class MusicFileError extends Error {
  readonly status: number
  constructor (message: string, status = 502) {
    super(message)
    this.status = status
  }
}

export interface MusicFilesOptions {
  db: DatabaseSync
  dir: string
  source: AudioSource
  /** Total size kept, in bytes. */
  capBytes: number
  /** Downloads at once. */
  parallel?: number
  log?: (msg: string) => void
  now?: () => number
}

export class MusicFiles {
  private readonly o: Required<Omit<MusicFilesOptions, 'log' | 'now'>> & { log: (m: string) => void; now: () => number }
  private readonly inflight = new Map<string, Promise<string>>()
  private readonly failed = new Map<string, { at: number; message: string }>()
  private running = 0
  private readonly waiting: Array<() => void> = []

  constructor (opts: MusicFilesOptions) {
    this.o = { parallel: 2, log: () => {}, now: Date.now, ...opts }
    for (const k of ['audio', 'video']) mkdirSync(join(opts.dir, k), { recursive: true })
  }

  get source (): AudioSource { return this.o.source }

  path (trackId: string, kind: FileKind): string {
    return join(this.o.dir, kind, `${trackId}.${kind === 'audio' ? 'm4a' : 'mp4'}`)
  }

  /** The saved file, if it's here (and marks it as just played). */
  saved (trackId: string, kind: FileKind): { path: string; duration: number | null } | null {
    const row = this.o.db.prepare('SELECT duration FROM music_files WHERE track_id = ? AND kind = ?').get(trackId, kind) as { duration: number | null } | undefined
    if (!row) return null
    const path = this.path(trackId, kind)
    try { statSync(path) } catch {
      this.o.db.prepare('DELETE FROM music_files WHERE track_id = ? AND kind = ?').run(trackId, kind)
      return null
    }
    this.o.db.prepare('UPDATE music_files SET used_at = ? WHERE track_id = ? AND kind = ?').run(this.o.now(), trackId, kind)
    return { path, duration: row.duration }
  }

  /** Whether a fetch of this is running now. */
  busy (trackId: string, kind: FileKind): boolean { return this.inflight.has(`${kind}:${trackId}`) }

  /** The file's path, fetching it first if needed. Two calls for one song share one fetch. */
  ensure (track: MusicTrack, kind: FileKind): Promise<string> {
    const have = this.saved(track.id, kind)
    if (have) return Promise.resolve(have.path)
    const key = `${kind}:${track.id}`
    const fail = this.failed.get(key)
    if (fail && this.o.now() - fail.at < RETRY_AFTER_MS) return Promise.reject(new MusicFileError(fail.message, 404))
    let p = this.inflight.get(key)
    if (!p) {
      p = this.fetch(track, kind).finally(() => this.inflight.delete(key))
      p.catch(err => this.failed.set(key, { at: this.o.now(), message: (err as Error).message }))
      this.inflight.set(key, p)
    }
    return p
  }

  private async slot (): Promise<() => void> {
    if (this.running >= this.o.parallel) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.running++
    return () => { this.running--; this.waiting.shift()?.() }
  }

  private async fetch (track: MusicTrack, kind: FileKind): Promise<string> {
    const release = await this.slot()
    const dest = this.path(track.id, kind)
    const part = `${dest}.part${kind === 'audio' ? '.m4a' : '.mp4'}`
    const began = this.o.now()
    try {
      const got = kind === 'audio' ? await this.o.source.fetchAudio(track, part) : await this.o.source.fetchVideo(track, part)
      if (!got) throw new MusicFileError('There’s no music video for this song.', 404)
      renameSync(part, dest)
      const bytes = statSync(dest).size
      this.o.db.prepare(`INSERT INTO music_files (track_id, kind, ref, bytes, duration, used_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (track_id, kind) DO UPDATE SET ref = excluded.ref, bytes = excluded.bytes, duration = excluded.duration, used_at = excluded.used_at`)
        .run(track.id, kind, got.ref, bytes, got.duration ?? null, this.o.now())
      this.o.log(`music: saved ${kind} for a song in ${((this.o.now() - began) / 1000).toFixed(1)} s (${(bytes / 1e6).toFixed(1)} MB)`)
      this.evict()
      return dest
    } catch (err) {
      rmSync(part, { force: true })
      if (err instanceof MusicFileError) throw err
      throw new MusicFileError((err as Error).message || 'Couldn’t get this song.')
    } finally {
      release()
    }
  }

  /** Least recently played first, until the folder fits (songs being fetched or just saved stay). */
  private evict (): void {
    const total = Number((this.o.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM music_files').get() as { b: number }).b)
    if (total <= this.o.capBytes) return
    let over = total - this.o.capBytes
    const rows = this.o.db.prepare('SELECT track_id, kind, bytes FROM music_files ORDER BY used_at ASC').all() as Array<{ track_id: string; kind: FileKind; bytes: number }>
    for (const r of rows.slice(0, -2)) {
      if (over <= 0) break
      if (this.inflight.has(`${r.kind}:${r.track_id}`)) continue
      rmSync(this.path(r.track_id, r.kind), { force: true })
      this.o.db.prepare('DELETE FROM music_files WHERE track_id = ? AND kind = ?').run(r.track_id, r.kind)
      over -= Number(r.bytes)
    }
  }

  /**
   * Deletes every saved song but those in use: being fetched, or played (or queued next) in the last few minutes,
   * which a phone or TV may still be reading. Returns the bytes freed.
   */
  clear (): number {
    const recent = this.o.now() - IN_USE_MS
    const rows = this.o.db.prepare('SELECT track_id, kind, bytes, used_at FROM music_files').all() as Array<{ track_id: string; kind: FileKind; bytes: number; used_at: number }>
    let freed = 0
    for (const r of rows) {
      if (Number(r.used_at) > recent || this.inflight.has(`${r.kind}:${r.track_id}`)) continue
      try { rmSync(this.path(r.track_id, r.kind), { force: true }) } catch { continue } // open on Windows: next time
      this.o.db.prepare('DELETE FROM music_files WHERE track_id = ? AND kind = ?').run(r.track_id, r.kind)
      freed += Number(r.bytes)
    }
    return freed
  }

  usage (): { bytes: number; songs: number } {
    const r = this.o.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS b, SUM(kind = 'audio') AS n FROM music_files").get() as { b: number; n: number | null }
    return { bytes: Number(r.b), songs: Number(r.n ?? 0) }
  }
}
