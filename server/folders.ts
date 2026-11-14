import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// Where films and episodes are saved. The viewer can choose the folder (Storage page); a change applies to what
// downloads from then on. Torrents already saved stay where they are, and are still found there, until they're
// deleted (watched, cleared, or not played for a while). Then the old folder is forgotten.

/** A v1 info hash (40 hex) or a v2 one (64 hex): the only folders nexttupp makes in a download folder. */
export const INFO_HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

interface Saved { downloadsDir?: string; older?: string[] }

export class FolderError extends Error {
  readonly status = 400
}

export class DownloadFolders {
  readonly default: string
  private readonly file: string
  private saved: Saved

  constructor (dataDir: string) {
    this.default = resolve(dataDir, 'downloads')
    this.file = join(dataDir, 'folders.json')
    try {
      this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as Saved : {}
    } catch { this.saved = {} }
    mkdirSync(this.current, { recursive: true })
  }

  /** Where new downloads go. */
  get current (): string {
    return this.saved.downloadsDir ?? this.default
  }

  /** Every folder that may hold a torrent: the current one first. */
  all (): string[] {
    return [...new Set([this.current, ...(this.saved.older ?? [])])]
  }

  /** A torrent's folder: where it's already saved, or else in the current folder. */
  of (infoHash: string): string {
    for (const root of this.all()) {
      const dir = join(root, infoHash)
      if (existsSync(dir)) return dir
    }
    return join(this.current, infoHash)
  }

  /** Saves new downloads in `path` from now on. Throws a FolderError the viewer can read when it can't be used. */
  set (path: string): void {
    const typed = path.trim().replace(/^~(?=$|[\\/])/, homedir())
    if (!typed || !isAbsolute(typed)) throw new FolderError('Give the full path of a folder.')
    const next = resolve(typed)
    const prev = this.current
    if (next === prev) return
    // Not inside one of the torrents' own folders.
    if (this.all().some(root => inside(next, root) && INFO_HASH.test(relative(root, next).split(sep)[0]))) throw new FolderError('That folder is inside a download. Choose another.')
    try {
      mkdirSync(next, { recursive: true })
      const probe = join(next, `.nexttupp-${process.pid}`)
      writeFileSync(probe, '')
      rmSync(probe)
    } catch (err) {
      throw new FolderError(`nexttupp can’t save in that folder (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`)
    }
    const older = [prev, ...(this.saved.older ?? [])].filter(d => d !== next)
    this.saved = { downloadsDir: next === this.default ? undefined : next, older }
    this.prune()
    this.write()
  }

  /** Forgets earlier folders that no longer hold any torrent. */
  prune (): void {
    const older = (this.saved.older ?? []).filter(d => d !== this.current && holdsTorrents(d))
    if (older.length === (this.saved.older ?? []).length) return
    this.saved = { ...this.saved, older: older.length ? older : undefined }
    this.write()
  }

  private write (): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.saved, null, 2))
    renameSync(tmp, this.file)
  }
}

function inside (child: string, parent: string): boolean {
  const r = relative(parent, child)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

function holdsTorrents (dir: string): boolean {
  try { return readdirSync(dir).some(n => INFO_HASH.test(n)) } catch { return false }
}
