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
}

export class Library {
  private readonly file: string
  private readonly engine: TorrentEngine
  private readonly downloadsDir: string
  private entries: LibraryEntry[]

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
    if (!deleteFiles) return
    if (session) await this.engine.close(session)
    const shared = this.entries.some(e => e.infoHash === entry.infoHash)
    const inUse = this.engine.list().some(s => s.infoHash === entry.infoHash)
    if (!shared && !inUse) await rm(join(this.downloadsDir, entry.infoHash), { recursive: true, force: true })
  }

  /** Re-opens and resumes every kept download. Failures are logged, never fatal. */
  async resumeAll (log: (msg: string) => void): Promise<void> {
    for (const e of this.entries) {
      try {
        const session = await this.engine.open({ infoHash: e.infoHash, fileIdx: e.fileIdx, fileName: e.fileName, title: e.title })
        this.engine.pin(session)
        log(`resumed download: ${e.title}`)
      } catch (err) {
        log(`could not resume ${e.title}: ${(err as Error).message}`)
      }
    }
  }
}
