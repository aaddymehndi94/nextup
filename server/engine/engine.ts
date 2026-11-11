import WebTorrent, { type Torrent, type TorrentFile } from 'webtorrent'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OpenSessionRequest, SessionStats } from '../../shared/types.ts'
import { DEFAULT_TRACKERS } from '../config.ts'
import { StreamReader } from './reader.ts'

const VIDEO_RE = /\.(mkv|mp4|m4v|avi|webm|mov|ts|m2ts|wmv|mpg|mpeg|flv)$/i
const METADATA_TIMEOUT_MS = 90_000

function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineError('Could not get torrent metadata from any peer within 90s. The swarm may be dead; try another source, or download it to watch later.', 504)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, err => { clearTimeout(timer); reject(err) })
  })
}

/** One playable video file inside a torrent. Several sessions may share a torrent (season packs). */
export interface Session {
  id: string
  infoHash: string
  title?: string
  torrent: Torrent
  file: TorrentFile
  pinned: boolean
  /** Opened in private mode: nothing about it is logged, and its torrent's data is deleted when it closes. */
  private: boolean
  activeStreams: number
  lastActive: number
  /** Open readers, oldest first. Only the newest gets urgent priority. */
  readers: StreamReader[]
}

export class EngineError extends Error {
  readonly status: number
  constructor (message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function sessionId (infoHash: string, fileIdx: number): string {
  return `${infoHash.toLowerCase()}-${fileIdx}`
}

/**
 * Picks the video file to play. Prefers the provider's file index, then a file-name match,
 * then the largest video file. Exported for testing.
 */
export function pickFile (files: Array<{ name: string; length: number }>, fileIdx?: number, fileName?: string): number {
  if (fileIdx !== undefined && files[fileIdx] && VIDEO_RE.test(files[fileIdx].name)) {
    if (!fileName || files[fileIdx].name === fileName) return fileIdx
  }
  if (fileName) {
    const byName = files.findIndex(f => f.name === fileName)
    if (byName >= 0) return byName
  }
  if (fileIdx !== undefined && files[fileIdx] && VIDEO_RE.test(files[fileIdx].name)) return fileIdx
  let best = -1
  files.forEach((f, i) => { if (VIDEO_RE.test(f.name) && (best < 0 || f.length > files[best].length)) best = i })
  return best
}

export class TorrentEngine {
  private readonly client: WebTorrent
  private readonly sessions = new Map<string, Session>()
  /** In-flight opens, so concurrent requests for the same torrent share one add. */
  private readonly pending = new Map<string, Promise<Torrent>>()
  /** Info hashes a kept download is waiting on; a player's metadata timeout must not drop them. */
  private readonly patient = new Set<string>()
  private readonly downloadsDir: string
  private readonly torrentsDir: string
  /** Private-mode torrents, each in a random folder under here; wiped when they close and at every start. */
  private readonly privateDir: string
  /** Info hash → that private torrent's folder. */
  private readonly privateTorrents = new Map<string, string>()
  private readonly sweeper: NodeJS.Timeout
  private readonly idleMs: number

  constructor (dataDir: string, idleMs: number) {
    this.idleMs = idleMs
    this.downloadsDir = join(dataDir, 'downloads')
    this.torrentsDir = join(dataDir, 'torrents')
    this.privateDir = join(dataDir, 'private')
    mkdirSync(this.downloadsDir, { recursive: true })
    mkdirSync(this.torrentsDir, { recursive: true })
    // Whatever a private session left behind when the app last stopped without cleaning up (a crash, a power cut).
    rmSync(this.privateDir, { recursive: true, force: true })
    mkdirSync(this.privateDir, { recursive: true })
    // uTP is off on purpose: in our benchmark it cut throughput from ~20 MB/s to ~2 MB/s
    // and took 30s to deliver the first 4 MiB. TCP-only peers are plentiful. See docs/adr/0001.
    this.client = new WebTorrent({ utp: false, maxConns: 80 })
    this.client.on('error', err => console.error('[engine] client error:', (err as Error).message))
    this.sweeper = setInterval(() => this.sweepIdle(), 60_000)
    this.sweeper.unref()
  }

  /**
   * `patient` waits for metadata as long as it takes instead of giving up after 90s. A kept download
   * uses it, because a sparse swarm can take minutes to produce one peer. `private` (private mode) keeps
   * a torrent this opens out of the downloads folder and the saved metadata, and deletes it on close.
   */
  async open (req: OpenSessionRequest, opts: { patient?: boolean; private?: boolean } = {}): Promise<Session> {
    const infoHash = req.infoHash.toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(infoHash)) throw new EngineError('Invalid info hash', 400)

    // A download to keep, of a torrent a private session still has open: start it again in the downloads
    // folder, or the kept file would be deleted along with the private one.
    if (opts.patient && !opts.private && this.privateTorrents.has(infoHash)) await this.dropPrivate(infoHash)
    if (opts.patient) this.patient.add(infoHash)
    const torrent = await this.getTorrent(infoHash, req.trackers ?? [], opts.patient === true, opts.private === true)
    this.patient.delete(infoHash)
    const idx = pickFile(torrent.files, req.fileIdx, req.fileName)
    if (idx < 0) throw new EngineError('No video file found in this torrent', 422)

    const id = sessionId(infoHash, idx)
    let session = this.sessions.get(id)
    if (!session) {
      session = { id, infoHash, title: req.title, torrent, file: torrent.files[idx], pinned: false, private: false, activeStreams: 0, lastActive: Date.now(), readers: [] }
      this.sessions.set(id, session)
    }
    if (opts.private || this.privateTorrents.has(infoHash)) session.private = true
    session.lastActive = Date.now()
    return session
  }

  get (id: string): Session | undefined {
    const s = this.sessions.get(id)
    if (s && s.torrent.destroyed) { this.sessions.delete(id); return undefined }
    return s
  }

  list (): Session[] {
    return [...this.sessions.values()].filter(s => !s.torrent.destroyed)
  }

  /** True for a session opened in private mode, or one on a torrent a private session opened. */
  isPrivate (id: string): boolean {
    const s = this.sessions.get(id)
    return Boolean(s && (s.private || this.privateTorrents.has(s.infoHash)))
  }

  private async getTorrent (infoHash: string, trackers: string[], patient: boolean, isPrivate: boolean): Promise<Torrent> {
    const existing = await this.client.get(infoHash)
    if (existing && !existing.destroyed) {
      if (existing.ready) return existing
      return this.waitReady(existing, patient)
    }
    const inflight = this.pending.get(infoHash)
    if (inflight) return patient ? inflight : withTimeout(inflight, METADATA_TIMEOUT_MS)

    const p = (async () => {
      // Reuse saved metadata when we've seen this torrent before: no peer round-trip needed.
      const saved = join(this.torrentsDir, `${infoHash}.torrent`)
      const announce = [...new Set([...trackers, ...DEFAULT_TRACKERS])]
      const torrentId = existsSync(saved)
        ? readFileSync(saved)
        : `magnet:?xt=urn:btih:${infoHash}${announce.map(t => `&tr=${encodeURIComponent(t)}`).join('')}`
      // A private torrent's folder has a random name, so not even the folder says what it was.
      const path = isPrivate ? join(this.privateDir, randomUUID()) : join(this.downloadsDir, infoHash)
      if (isPrivate) this.privateTorrents.set(infoHash, path)
      const torrent = this.client.add(torrentId, { path, deselect: true, announce, strategy: 'sequential' })
      try {
        const ready = await this.waitReady(torrent, patient)
        if (!isPrivate && !existsSync(saved) && ready.torrentFile) writeFileSync(saved, ready.torrentFile)
        return ready
      } catch (err) {
        if (isPrivate) this.forgetPrivate(infoHash)
        throw err
      }
    })()
    this.pending.set(infoHash, p)
    try { return await p } finally { this.pending.delete(infoHash) }
  }

  private waitReady (torrent: Torrent, patient = false): Promise<Torrent> {
    return new Promise((resolve, reject) => {
      if (torrent.ready) return resolve(torrent)
      const timer = patient ? undefined : setTimeout(() => {
        cleanup()
        // A kept download may be waiting on the same swarm; only give up on it if nobody is.
        if (!this.patient.has(torrent.infoHash)) this.client.remove(torrent, { destroyStore: false }).catch(() => {})
        reject(new EngineError('Could not get torrent metadata from any peer within 90s. The swarm may be dead; try another source.', 504))
      }, METADATA_TIMEOUT_MS)
      const onReady = () => { cleanup(); resolve(torrent) }
      const onError = (err: Error) => { cleanup(); reject(new EngineError(err.message, 502)) }
      const cleanup = () => { clearTimeout(timer); torrent.off('ready', onReady); torrent.off('error', onError) }
      torrent.once('ready', onReady)
      torrent.once('error', onError)
    })
  }

  /** Reads bytes [start, end] of the session's file, prioritising those pieces in the swarm. */
  /**
   * Streams bytes [start, end] of the file. Pass the response's AbortSignal: an async generator that is
   * waiting for a piece cannot be cancelled from outside, so without it an abandoned request would keep
   * its urgent priority (and starve the next seek) until its piece happened to arrive.
   */
  read (session: Session, start: number, end: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    // The newest request is what the viewer is waiting on (a seek, or ffmpeg's jump to the seek point);
    // older readers on this file drop behind it until it finishes.
    const reader = new StreamReader(session.torrent, session.file, start, end)
    signal?.addEventListener('abort', () => reader.destroy(), { once: true })
    for (const r of session.readers) r.setActive(false)
    session.readers.push(reader)
    return (async function * () {
      try {
        yield * reader
      } finally {
        reader.destroy()
        session.readers = session.readers.filter(r => r !== reader)
        session.readers.at(-1)?.setActive(true)
      }
    })()
  }

  /** Marks the session as in use for the lifetime of a response. Returns a release function. */
  hold (session: Session): () => void {
    session.activeStreams++
    session.lastActive = Date.now()
    let released = false
    return () => {
      if (released) return
      released = true
      session.activeStreams--
      session.lastActive = Date.now()
    }
  }

  /** Download the whole file and keep it, so it can be watched later without waiting. */
  pin (session: Session): void {
    session.pinned = true
    // Background priority: a full download must never slow down what's being watched.
    session.file.select(0)
  }

  unpin (session: Session): void {
    session.pinned = false
    session.file.deselect()
  }

  stats (session: Session): SessionStats & { ranges: Array<[number, number]> } {
    const { torrent, file } = session
    return {
      id: session.id,
      infoHash: session.infoHash,
      name: session.title ?? torrent.name,
      fileName: file.name,
      fileSize: file.length,
      state: 'ready',
      peers: torrent.numPeers,
      downloadSpeed: Math.round(torrent.downloadSpeed),
      uploadSpeed: Math.round(torrent.uploadSpeed),
      downloaded: file.downloaded,
      progress: file.progress,
      pinned: session.pinned,
      ranges: this.downloadedRanges(session),
    }
  }

  /** Downloaded spans of the file as [startFraction, endFraction] pairs, merged, at most ~200 entries. */
  private downloadedRanges (session: Session): Array<[number, number]> {
    const { torrent, file } = session
    const first = file._startPiece
    const last = file._endPiece
    const count = last - first + 1
    if (count <= 0) return []
    const ranges: Array<[number, number]> = []
    let runStart = -1
    for (let i = first; i <= last + 1; i++) {
      const have = i <= last && torrent.bitfield.get(i)
      if (have && runStart < 0) runStart = i
      if (!have && runStart >= 0) {
        ranges.push([(runStart - first) / count, (i - first) / count])
        runStart = -1
      }
    }
    if (ranges.length <= 200) return ranges
    // Coalesce tiny gaps so the payload stays small for very fragmented files.
    const merged: Array<[number, number]> = []
    for (const r of ranges) {
      const prev = merged.at(-1)
      if (prev && r[0] - prev[1] < 0.005) prev[1] = r[1]; else merged.push([...r])
    }
    return merged
  }

  private sweepIdle (): void {
    const now = Date.now()
    const byTorrent = new Map<Torrent, Session[]>()
    for (const s of this.sessions.values()) byTorrent.set(s.torrent, [...(byTorrent.get(s.torrent) ?? []), s])
    for (const [torrent, sessions] of byTorrent) {
      const idle = sessions.every(s => !s.pinned && s.activeStreams === 0 && now - s.lastActive > this.idleMs)
      if (!idle) continue
      for (const s of sessions) this.sessions.delete(s.id)
      if (this.privateTorrents.has(torrent.infoHash)) { void this.dropPrivate(torrent.infoHash); continue }
      // Keep the data on disk: re-opening is instant for the parts already downloaded.
      this.client.remove(torrent, { destroyStore: false }).catch(() => {})
      console.log(`[engine] stopped idle torrent ${torrent.name}`)
    }
  }

  /** Stops a private torrent and deletes everything it wrote. */
  private async dropPrivate (infoHash: string): Promise<void> {
    for (const s of this.sessions.values()) if (s.infoHash === infoHash) this.sessions.delete(s.id)
    const t = await this.client.get(infoHash)
    if (t && !t.destroyed) await this.client.remove(t, { destroyStore: true }).catch(() => {})
    this.forgetPrivate(infoHash)
  }

  private forgetPrivate (infoHash: string): void {
    const path = this.privateTorrents.get(infoHash)
    this.privateTorrents.delete(infoHash)
    if (path) rmSync(path, { recursive: true, force: true })
  }

  /** Peers connected to a torrent that may still be waiting for metadata; null if it isn't loaded. */
  async swarm (infoHash: string): Promise<{ peers: number; downloadSpeed: number } | null> {
    const t = await this.client.get(infoHash)
    return t && !t.destroyed ? { peers: t.numPeers, downloadSpeed: t.downloadSpeed } : null
  }

  /** Drops a torrent nobody is using any more (a kept download removed before it got metadata). */
  async abandon (infoHash: string): Promise<void> {
    this.patient.delete(infoHash)
    if ([...this.sessions.values()].some(s => s.infoHash === infoHash)) return
    const t = await this.client.get(infoHash)
    if (t && !t.destroyed) await this.client.remove(t, { destroyStore: false }).catch(() => {})
  }

  async close (session: Session): Promise<void> {
    this.sessions.delete(session.id)
    if (session.pinned) return
    const stillUsed = [...this.sessions.values()].some(s => s.torrent === session.torrent)
    if (stillUsed) return
    if (this.privateTorrents.has(session.infoHash)) await this.dropPrivate(session.infoHash)
    else await this.client.remove(session.torrent, { destroyStore: false }).catch(() => {})
  }

  destroy (): Promise<void> {
    clearInterval(this.sweeper)
    return new Promise(resolve => this.client.destroy(() => {
      rmSync(this.privateDir, { recursive: true, force: true })
      resolve()
    }))
  }
}
