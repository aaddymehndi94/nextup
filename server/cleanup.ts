import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { TorrentEngine } from './engine/engine.ts'
import type { Library, LibraryEntry } from './library.ts'
import { INFO_HASH } from './folders.ts'

// Films and episodes don't stay on this computer longer than they're useful; each is gigabytes. Music
// (data/music) is never touched. See docs/adr/0001, "Update".
// - Watched to the end: deleted, both what the engine keeps after streaming (downloads/<info hash>/) and
//   titles kept with "Download to watch later". Nobody watches them again soon.
// - Streamed and not played for a day: the whole torrent goes (its folder and saved metadata).
// - Kept with "Download to watch later" and not played for 14 days (counted from when it was kept, or last
//   played): it leaves the Downloads list and its file is deleted.
//
// A file to delete is queued (in cleanup.json, so a restart or a failed delete doesn't lose it) and deleted
// once nothing can still read its torrent: no stream open on it for the engine's idle time, and not playing on
// a TV. Only that file goes; the torrent's folder and saved metadata go too once nothing else in it is worth
// keeping. cleanup.json also records when each torrent was last played.

/** A watched file waiting to be deleted. */
export interface WatchedFile {
  /** Session id: `${infoHash}-${fileIdx}` */
  id: string
  infoHash: string
  /** The file's path in the torrent, under downloads/<infoHash>/. Unknown for a kept download that wasn't open. */
  path?: string
  fileName: string
  title: string
  /** Tells a neighbouring file's own data from the edge pieces that streaming this one wrote into it. */
  pieceLength?: number
  /** When it was watched (or found unplayed). */
  at: number
  /** Not played for 14 days, rather than watched. */
  reason?: 'unplayed'
}

/** When a torrent was last played; its title, for the log. */
interface Use { at: number; title?: string }

/** A torrent on disk that nobody kept: what streaming left, deleted a day after it was last played. */
export interface StreamedTorrent {
  infoHash: string
  title: string
  bytes: number
  /** When it was last played (0: unknown). */
  playedAt: number
  /** When cleanup deletes it if nobody plays it again. */
  deletesAt: number
  /** Playing now (here or on a TV): it can't be deleted yet. */
  inUse: boolean
}

/** Where torrents are saved (server/folders.ts). */
export interface Folders { of (infoHash: string): string; all (): string[] }

type Engine = Pick<TorrentEngine, 'list' | 'get' | 'isPrivate' | 'inUse' | 'unload'>
type Kept = Pick<Library, 'list' | 'remove' | 'resumeMissing'>

const SWEEP_MS = 60_000
/** Used when the piece size isn't known: the largest common one. */
const DEFAULT_PIECE = 16 * 2 ** 20
/** Streamed data not played for this long is deleted. */
const STREAMED_KEEP_MS = 24 * 3600_000
/** A download kept for later and not played for this long is deleted. */
const KEPT_KEEP_MS = 14 * 24 * 3600_000

export class WatchedCleanup {
  private readonly file: string
  private readonly folders: Folders
  private readonly torrentsDir: string
  private readonly engine: Engine
  private readonly library: Kept
  private readonly casting: () => string | undefined
  private readonly log: (msg: string) => void
  private queue: WatchedFile[]
  private used: Record<string, Use>
  private dirty = false
  private readonly now: () => number
  /** Failures already logged, so a locked file is reported once, not every minute. */
  private readonly warned = new Set<string>()
  private timer?: NodeJS.Timeout
  private running?: Promise<void>
  private closed = false

  constructor (opts: {
    dataDir: string
    /** Default: <dataDir>/downloads only. */
    folders?: Folders
    engine: Engine
    library: Kept
    /** The session playing on a TV, if any. */
    casting?: () => string | undefined
    log?: (msg: string) => void
    now?: () => number
  }) {
    const downloads = resolve(opts.dataDir, 'downloads')
    this.folders = opts.folders ?? { of: h => join(downloads, h), all: () => [downloads] }
    this.torrentsDir = resolve(opts.dataDir, 'torrents')
    this.file = join(opts.dataDir, 'cleanup.json')
    this.engine = opts.engine
    this.library = opts.library
    this.casting = opts.casting ?? (() => undefined)
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
    let state: { watched?: WatchedFile[]; used?: Record<string, Use> } | WatchedFile[] = {}
    try {
      if (existsSync(this.file)) state = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch { /* start afresh */ }
    this.queue = Array.isArray(state) ? state : state.watched ?? []
    this.used = Array.isArray(state) ? {} : state.used ?? {}
  }

  /** The player opened this torrent (not in private mode): its data is in use again, so the clock restarts. */
  touch (infoHash: string, title?: string): void {
    this.used[infoHash] = { at: this.now(), title: title ?? this.used[infoHash]?.title }
    this.dirty = true
  }

  /** Files waiting to be deleted. */
  pending (): WatchedFile[] {
    return [...this.queue]
  }

  /**
   * A film or episode was watched to the end. Its files are queued for deletion, wherever they came from:
   * an open stream of it, or a download kept for later (which leaves the Downloads list now). Private
   * sessions are skipped; their data is deleted when they close anyway.
   */
  async finished (streamId: string): Promise<void> {
    if (!streamId) return // a session without one must never match another without one
    const before = this.queue.length
    // A kept download stops downloading the rest; its file goes when nothing reads it any more.
    for (const e of this.library.list()) if (e.streamId === streamId) await this.drop(e)
    for (const s of this.engine.list()) {
      if (s.streamId !== streamId || this.engine.isPrivate(s.id)) continue
      this.add({ id: s.id, infoHash: s.infoHash, path: s.file.path, fileName: s.file.name, title: s.title ?? s.file.name, pieceLength: s.torrent.pieceLength })
    }
    if (this.queue.length > before) this.save()
  }

  /** Queues a kept download's file and takes it off the Downloads list (which stops downloading the rest). */
  private async drop (e: LibraryEntry, reason?: 'unplayed'): Promise<void> {
    const s = e.pending ? undefined : this.engine.get(e.id)
    if (!e.pending) this.add({ id: e.id, infoHash: e.infoHash, path: s?.file.path, fileName: e.fileName, title: e.title, pieceLength: s?.torrent.pieceLength, reason })
    await this.library.remove(e.id, false)
  }

  /** Sweeps every minute. (Sweep once first at start-up, before kept downloads are opened again.) */
  start (): void {
    this.timer ??= setInterval(() => { void this.sweep() }, SWEEP_MS)
    this.timer.unref()
  }

  /** After the engine has stopped: nothing can be playing any more, so whatever is due goes now. */
  async close (): Promise<void> {
    clearInterval(this.timer)
    this.closed = true
    await this.running
    await this.sweep()
  }

  /**
   * Deletes every queued file whose torrent nothing is using, and what hasn't been played for long enough.
   * A failure is logged once and retried next time.
   */
  async sweep (): Promise<void> {
    if (this.running) return this.running
    const run = (async () => {
      try {
        // Streaming now (a long film, a TV) counts as played.
        for (const s of this.engine.list()) if (s.activeStreams > 0 && !this.engine.isPrivate(s.id)) this.touch(s.infoHash, s.title)
        await this.expireKept()
        for (const infoHash of new Set(this.queue.map(w => w.infoHash))) await this.sweepTorrent(infoHash)
        await this.expireStreamed()
      } catch (err) {
        this.log(`cleanup: ${(err as Error).message}`)
      }
      if (this.dirty) this.save()
    })()
    this.running = run
    await run
    this.running = undefined
  }

  private async sweepTorrent (infoHash: string): Promise<void> {
    // The folder below is removed whole: only ever an info hash's own folder under downloads/.
    if (!INFO_HASH.test(infoHash)) { this.forget(w => w.infoHash === infoHash); return }
    // Kept again after it was watched (Download pressed since): the viewer wants it after all.
    const keptSince = (w: WatchedFile) => this.library.list().some(e => e.id === w.id && e.addedAt > w.at)
    if (this.queue.some(w => w.infoHash === infoHash && keptSince(w))) this.forget(w => w.infoHash === infoHash && keptSince(w))
    const due = this.queue.filter(w => w.infoHash === infoHash)
    if (due.length === 0) return

    const tv = this.casting()
    if (this.engine.inUse(infoHash) || tv?.startsWith(`${infoHash}-`)) return
    try {
      await this.engine.unload(infoHash)
    } catch (err) {
      this.warnOnce(infoHash, `cleanup: could not stop ${due[0].title} to delete it (${(err as Error).message}); will try again`)
      return
    }

    const folder = resolve(this.folders.of(infoHash))
    const deleted: Array<{ w: WatchedFile; freed: number }> = []
    for (const w of due) {
      try {
        deleted.push({ w, freed: await this.deleteFile(folder, w) })
        this.warned.delete(w.id)
      } catch (err) {
        this.warnOnce(w.id, `cleanup: could not delete ${w.title} yet (${(err as Error).message}); will try again`)
      }
    }
    if (deleted.length > 0) this.forget(w => deleted.some(d => d.w === w))

    // Every watched file of this torrent is gone. If nothing else in it is worth keeping (only the edges of
    // neighbouring files that streaming wrote into), the torrent goes too: its folder and saved metadata.
    const keptHere = this.library.list().some(e => e.infoHash === infoHash)
    let rest = 0
    let torrentGone = false
    if (!keptHere && !this.queue.some(w => w.infoHash === infoHash)) {
      const pieceLength = Math.max(...due.map(w => w.pieceLength ?? DEFAULT_PIECE))
      const left = await filesIn(folder)
      if (left.every(f => f.bytes <= 2 * pieceLength)) {
        try {
          await rm(folder, { recursive: true, force: true, maxRetries: 3 })
          await rm(join(this.torrentsDir, `${infoHash}.torrent`), { force: true })
          rest = left.reduce((sum, f) => sum + f.bytes, 0)
          torrentGone = true
        } catch (err) {
          this.log(`cleanup: could not remove the rest of ${due[0].title} (${(err as Error).message})`)
        }
      }
    }

    deleted.forEach(({ w, freed }, i) => {
      const last = i === deleted.length - 1
      const bytes = freed + (last ? rest : 0)
      if (bytes > 0) this.log(`${w.reason === 'unplayed' ? 'not played for 14 days' : 'watched'}, so deleted: ${w.title} (${size(bytes)} freed${last && torrentGone ? ', torrent removed' : ''})`)
    })

    // Kept downloads beside it (other episodes of a season pack) were stopped with the torrent: carry on.
    if (keptHere && !this.closed) this.library.resumeMissing()
  }

  /** Downloads kept for later and not played for 14 days leave the list; their files are queued. */
  private async expireKept (): Promise<void> {
    const now = this.now()
    for (const e of this.library.list()) {
      const u = this.used[e.infoHash]
      // A download from before this was recorded gets its 14 days from now.
      if (!u) { this.used[e.infoHash] = { at: now, title: e.title }; this.dirty = true; continue }
      if (now - Math.max(e.addedAt, u.at) >= KEPT_KEEP_MS) await this.drop(e, 'unplayed')
    }
  }

  /** Info hashes with something on disk: a folder in a download folder, or saved metadata. */
  private async onDisk (): Promise<Set<string>> {
    const names = new Set<string>()
    for (const root of this.folders.all()) for (const n of await readdir(root).catch(() => [])) if (INFO_HASH.test(n)) names.add(n)
    for (const n of await readdir(this.torrentsDir).catch(() => [])) if (n.endsWith('.torrent')) names.add(n.slice(0, -'.torrent'.length))
    return names
  }

  private playing (infoHash: string): boolean {
    return this.engine.inUse(infoHash) || Boolean(this.casting()?.startsWith(`${infoHash}-`))
  }

  /** Torrents nobody kept and nobody has played for a day: their folder and saved metadata go. */
  private async expireStreamed (): Promise<void> {
    const now = this.now()
    const kept = new Set(this.library.list().map(e => e.infoHash))
    const names = await this.onDisk()
    for (const h of Object.keys(this.used)) if (!names.has(h) && !kept.has(h)) { delete this.used[h]; this.dirty = true }
    for (const infoHash of names) {
      if (!INFO_HASH.test(infoHash) || kept.has(infoHash) || this.playing(infoHash)) continue
      // Streamed before this was recorded: its newest write says when.
      let u = this.used[infoHash]
      if (!u) { u = this.used[infoHash] = { at: await lastWritten(this.folders.of(infoHash), join(this.torrentsDir, `${infoHash}.torrent`)) }; this.dirty = true }
      if (now - u.at < STREAMED_KEEP_MS) continue
      const gone = await this.deleteTorrent(infoHash)
      if (gone && gone.bytes > 0) this.log(`not played for a day, so deleted: ${gone.title} (${size(gone.bytes)} freed)`)
    }
  }

  /** What streaming left on this computer (torrents nobody kept), largest first. */
  async streamed (): Promise<StreamedTorrent[]> {
    const kept = new Set(this.library.list().map(e => e.infoHash))
    const out: StreamedTorrent[] = []
    for (const infoHash of await this.onDisk()) {
      if (kept.has(infoHash)) continue
      const files = await filesIn(this.folders.of(infoHash))
      const bytes = files.reduce((sum, f) => sum + f.bytes, 0)
      const u = this.used[infoHash]
      const playedAt = u?.at ?? 0
      out.push({ infoHash, title: u?.title ?? titleOf(files, infoHash), bytes, playedAt, deletesAt: playedAt ? playedAt + STREAMED_KEEP_MS : 0, inUse: this.playing(infoHash) })
    }
    return out.sort((a, b) => b.bytes - a.bytes)
  }

  /**
   * Deletes a torrent nobody kept, now: its folder and saved metadata. Returns what it freed, or null when it
   * can't go: it's kept, playing, or its files are still open.
   */
  async remove (infoHash: string): Promise<{ title: string; bytes: number } | null> {
    if (!INFO_HASH.test(infoHash) || this.library.list().some(e => e.infoHash === infoHash) || this.playing(infoHash)) return null
    const gone = await this.deleteTorrent(infoHash)
    if (this.dirty) this.save()
    return gone
  }

  private async deleteTorrent (infoHash: string): Promise<{ title: string; bytes: number } | null> {
    const folder = this.folders.of(infoHash)
    const files = await filesIn(folder)
    const title = this.used[infoHash]?.title ?? titleOf(files, infoHash)
    try {
      await this.engine.unload(infoHash)
      await rm(folder, { recursive: true, force: true, maxRetries: 3 })
      await rm(join(this.torrentsDir, `${infoHash}.torrent`), { force: true })
    } catch (err) {
      this.warnOnce(infoHash, `cleanup: could not delete ${title} yet (${(err as Error).message}); will try again`)
      return null
    }
    delete this.used[infoHash]
    this.dirty = true
    this.forget(w => w.infoHash === infoHash)
    return { title, bytes: files.reduce((sum, f) => sum + f.bytes, 0) }
  }

  /** Deletes one file; returns the bytes it held on disk (0 if it was already gone). */
  private async deleteFile (folder: string, w: WatchedFile): Promise<number> {
    const rel = w.path !== undefined ? storedPath(w.path) : (await filesIn(folder)).find(f => basename(f.path) === storedPath(w.fileName))?.path
    if (rel === undefined) return 0
    const file = resolve(folder, rel)
    if (!file.startsWith(folder + sep)) return 0 // a torrent's own file name must not reach outside its folder
    const bytes = await bytesOnDisk(file)
    await rm(file, { force: true, maxRetries: 3 })
    return bytes
  }

  private add (w: Omit<WatchedFile, 'at'>): void {
    if (this.queue.some(q => q.id === w.id)) return
    this.queue.push({ ...w, at: this.now() })
  }

  private forget (match: (w: WatchedFile) => boolean): void {
    this.queue = this.queue.filter(w => !match(w))
    this.save()
  }

  private warnOnce (key: string, msg: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.log(msg)
  }

  private save (): void {
    // Write-then-rename, as library.json does.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ watched: this.queue, used: this.used }, null, 2))
    renameSync(tmp, this.file)
    this.dirty = false
  }
}

/** Where fs-chunk-store (WebTorrent's file store) puts a torrent's file: these characters are dropped from its name. */
export function storedPath (path: string): string {
  // eslint-disable-next-line no-control-regex
  return join(dirname(path), basename(path).replace(/[<>:"/\\|?*\u0000-\u001F]/g, ''))
}

/** Bytes a file really takes: torrent files are sparse until their pieces arrive. */
export async function bytesOnDisk (path: string): Promise<number> {
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) return 0
  return Math.min(st.size, st.blocks > 0 ? st.blocks * 512 : st.size)
}

/** Every file under a folder, relative to it, with the bytes it takes; none if the folder is gone. */
export async function filesIn (folder: string): Promise<Array<{ path: string; bytes: number }>> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
  return Promise.all(entries.filter(e => e.isFile()).map(async e => {
    const abs = join(e.parentPath, e.name)
    return { path: abs.slice(folder.length + 1), bytes: await bytesOnDisk(abs) }
  }))
}

/** When anything in a torrent's folder (or its saved metadata) was last written; 0 if there's nothing. */
async function lastWritten (folder: string, meta: string): Promise<number> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
  const paths = [folder, meta, ...entries.map(e => join(e.parentPath, e.name))]
  const times = await Promise.all(paths.map(p => stat(p).then(st => st.mtimeMs, () => 0)))
  return Math.max(0, ...times)
}

/** A torrent's name for people when the player never said: its largest file's, as words ("Show S01E01"). */
function titleOf (files: Array<{ path: string; bytes: number }>, infoHash: string): string {
  const largest = [...files].sort((a, b) => b.bytes - a.bytes)[0]
  return largest ? basename(largest.path).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').trim() : `Torrent ${infoHash.slice(0, 8)}`
}

function size (bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`
}
