import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaType } from '../shared/types.ts'
import type { TorrentEngine } from './engine/engine.ts'

// Downloads the viewer asked to keep. Persisted so they survive restarts, and re-opened from the saved
// .torrent file on startup, so a finished download plays with no network at all.

export interface LibraryEntry {
  /** Session id: `${infoHash}-${fileIdx}` */
  id: string
  infoHash: string
  fileIdx: number
  fileName: string
  /** Display name, e.g. "Breaking Bad · S1E1 Pilot" */
  title: string
  type: MediaType
  imdbId: string
  /** Movie id or `tt…:season:episode` */
  streamId: string
  addedAt: number
  /** Extra trackers from the source listing; helps a sparse swarm find peers. */
  trackers?: string[]
  /**
   * Kept straight from the source list and still waiting for torrent metadata. Until then `fileIdx` is the
   * listing's hint (-1 when it gave none) and `id` is provisional.
   */
  pending?: boolean
}

const RETRY_MS = 3 * 60_000

export class Library {
  private readonly file: string
  private readonly engine: TorrentEngine
  private readonly downloadsDir: string
  private entries: LibraryEntry[]
  private readonly starting = new Set<string>()
  private log: (msg: string) => void = () => {}

  constructor (dataDir: string, engine: TorrentEngine) {
    this.engine = engine
    this.downloadsDir = join(dataDir, 'downloads')
    this.file = join(dataDir, 'library.json')
    this.entries = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as LibraryEntry[] : []
  }

  list (): LibraryEntry[] {
    return [...this.entries].sort((a, b) => b.addedAt - a.addedAt)
  }

  get (id: string): LibraryEntry | undefined {
    return this.entries.find(e => e.id === id)
  }

  private save (): void {
    // Write-then-rename so a crash mid-write can't leave a truncated library.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2))
    renameSync(tmp, this.file)
  }

  add (entry: LibraryEntry): void {
    this.entries = [...this.entries.filter(e => e.id !== entry.id), entry]
    this.save()
  }

  /**
   * Forgets the download. With `deleteFiles`, also closes it and frees the disk space unless another kept
   * file shares the torrent; without, it only stops the background download (used while still watching).
   */
  async remove (id: string, deleteFiles: boolean): Promise<void> {
    const entry = this.get(id)
    if (!entry) return
    this.entries = this.entries.filter(e => e.id !== id)
    this.save()
    const session = this.engine.get(id)
    if (session) this.engine.unpin(session)
    if (entry.pending || !session) await this.engine.abandon(entry.infoHash) // still waiting for peers
    if (!deleteFiles) return
    if (session) await this.engine.close(session)
    const shared = this.entries.some(e => e.infoHash === entry.infoHash)
    const inUse = this.engine.list().some(s => s.infoHash === entry.infoHash)
    if (!shared && !inUse) await rm(join(this.downloadsDir, entry.infoHash), { recursive: true, force: true })
  }

  /**
   * Keeps a download without playing it first. Returns at once: the entry is saved as pending and the
   * torrent waits for peers as long as it takes (retried every few minutes and after restarts).
   */
  download (entry: Omit<LibraryEntry, 'pending'>): LibraryEntry {
    const pending: LibraryEntry = { ...entry, pending: true }
    this.add(pending)
    void this.start(pending.id)
    return pending
  }

  private async start (id: string): Promise<void> {
    const e = this.get(id)
    if (!e || this.starting.has(id)) return
    this.starting.add(id)
    try {
      const session = await this.engine.open(
        { infoHash: e.infoHash, fileIdx: e.fileIdx >= 0 ? e.fileIdx : undefined, fileName: e.fileName || undefined, title: e.title, trackers: e.trackers },
        { patient: true },
      )
      if (!this.get(id)) return // deleted while we were waiting for peers
      this.engine.pin(session)
      const ready: LibraryEntry = { ...e, id: session.id, fileIdx: Number(session.id.split('-')[1]), fileName: session.file.name }
      delete ready.pending
      this.entries = [...this.entries.filter(x => x.id !== id && x.id !== session.id), ready]
      this.save()
      this.log(`downloading: ${e.title}`)
    } catch (err) {
      this.log(`still waiting to download ${e.title}: ${(err as Error).message}`)
    } finally {
      this.starting.delete(id)
    }
  }

  /**
   * Re-opens and resumes every kept download, patiently and side by side: a dead swarm must not hold up the
   * others, and anything not yet open (still waiting for peers, or dropped) is tried again every few minutes.
   */
  async resumeAll (log: (msg: string) => void): Promise<void> {
    this.log = log
    setInterval(() => { for (const e of this.entries) if (e.pending || !this.engine.get(e.id)) void this.start(e.id) }, RETRY_MS).unref()
    for (const e of this.entries) void this.start(e.id)
  }
}
