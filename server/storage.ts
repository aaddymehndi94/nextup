import type { FastifyInstance } from 'fastify'
import { readdir, stat, statfs } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { DiskSpace, StorageReport, StoredDownload } from '../shared/storage.ts'
import { bytesOnDisk, filesIn, storedPath, type WatchedCleanup } from './cleanup.ts'
import { FolderError, INFO_HASH, type DownloadFolders } from './folders.ts'
import { HttpError } from './http.ts'
import { isLoopback } from './lan/net.ts'
import type { Library } from './library.ts'
import type { MusicFiles } from './music/files.ts'
import type { Trailers } from './trailers.ts'

// The Storage page: what nexttupp keeps on this computer, how much room it takes and how much is left, and
// ways to delete any of it. Nothing here deletes what's playing.

export interface StorageDeps {
  dataDir: string
  folders: DownloadFolders
  library: Pick<Library, 'list' | 'remove'>
  cleanup: Pick<WatchedCleanup, 'streamed' | 'remove'>
  music: { files: Pick<MusicFiles, 'usage' | 'clear'>; dir: string }
  trailers: { cache: Pick<Trailers, 'usage' | 'clear'>; dir: string }
  /** Playing now, here or on a TV. */
  playing: (infoHash: string) => boolean
}

async function space (path: string): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path)
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
  } catch { return null }
}

const sum = (files: Array<{ bytes: number }>) => files.reduce((n, f) => n + f.bytes, 0)

/** Each kept download's bytes on disk: its file's. */
async function downloads (d: StorageDeps): Promise<StoredDownload[]> {
  const entries = d.library.list()
  const out: StoredDownload[] = []
  for (const infoHash of new Set(entries.map(e => e.infoHash))) {
    const files = await filesIn(d.folders.of(infoHash))
    const mine = entries.filter(e => e.infoHash === infoHash)
    for (const e of mine) {
      // The file's own bytes, as Downloads shows them; the whole folder only when the file isn't found by name.
      const own = files.find(f => basename(f.path) === basename(storedPath(e.fileName)))?.bytes
      const bytes = own ?? (mine.length === 1 ? sum(files) : 0)
      out.push({ id: e.id, title: e.title, type: e.type, imdbId: e.imdbId, bytes, paused: e.paused || undefined })
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

/** nexttupp's own files: everything in its data folder but downloads, music and trailers. */
async function appBytes (d: StorageDeps): Promise<number> {
  const skip = new Set([...d.folders.all(), d.music.dir, d.trailers.dir, join(d.dataDir, 'private')].map(p => resolve(p)))
  let total = 0
  for (const e of await readdir(d.dataDir, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(d.dataDir, e.name)
    if (skip.has(path)) continue
    total += e.isDirectory() ? sum(await filesIn(path)) : await bytesOnDisk(path)
  }
  return total
}

export async function storageReport (d: StorageDeps, local: boolean): Promise<StorageReport> {
  const current = d.folders.current
  const [items, streamed, appData, disk, dataDev, folderDev] = await Promise.all([
    downloads(d), d.cleanup.streamed(), appBytes(d), space(current),
    stat(d.dataDir).then(s => s.dev, () => 0), stat(current).then(s => s.dev, () => 0),
  ])
  const music = d.music.files.usage()
  const musicBytes = sum(await filesIn(d.music.dir))
  return {
    folder: { path: current, isDefault: current === d.folders.default, older: d.folders.all().slice(1), canChange: local },
    disk,
    dataDisk: dataDev && folderDev && dataDev !== folderDev ? await space(d.dataDir) : null,
    downloads: { bytes: sum(items), items },
    streamed: { bytes: sum(streamed), items: streamed },
    music: { bytes: Math.max(musicBytes, music.bytes), songs: music.songs },
    trailers: d.trailers.cache.usage(),
    app: { bytes: appData },
  }
}

export function registerStorageRoutes (app: FastifyInstance, d: StorageDeps): void {
  const local = (addr: string | undefined) => isLoopback(addr)

  app.get('/api/storage', async req => storageReport(d, local(req.socket.remoteAddress)))

  // Choosing the computer's folders is for the computer itself, not a phone on the Wi-Fi.
  app.put<{ Body: { path?: string } }>('/api/storage/folder', async req => {
    if (!local(req.socket.remoteAddress)) throw new HttpError(403, 'Change the download folder on the computer that runs nexttupp.')
    const path = req.body?.path
    if (typeof path !== 'string' || path.length > 4096) throw new HttpError(400, 'path is required')
    try {
      d.folders.set(path === '' ? d.folders.default : path)
    } catch (err) {
      if (err instanceof FolderError) throw new HttpError(400, err.message)
      throw err
    }
    return storageReport(d, true)
  })

  /** One streamed torrent, or all of them that aren't playing. */
  app.delete<{ Params: { infoHash: string } }>('/api/storage/streamed/:infoHash', async req => {
    if (!INFO_HASH.test(req.params.infoHash)) throw new HttpError(400, 'Bad info hash')
    const gone = await d.cleanup.remove(req.params.infoHash.toLowerCase())
    if (!gone) throw new HttpError(409, 'It’s playing now, or kept as a download. Try again when it has stopped.')
    d.folders.prune()
    return { freed: gone.bytes }
  })
  app.delete('/api/storage/streamed', async () => {
    let freed = 0
    let skipped = 0
    for (const s of await d.cleanup.streamed()) {
      const gone = s.inUse ? null : await d.cleanup.remove(s.infoHash)
      if (gone) freed += gone.bytes; else skipped++
    }
    d.folders.prune()
    return { freed, skipped }
  })

  app.delete('/api/storage/downloads', async () => {
    const playing = new Set(d.library.list().filter(e => d.playing(e.infoHash)).map(e => e.id))
    const items = (await downloads(d)).filter(e => !playing.has(e.id))
    for (const e of items) await d.library.remove(e.id, true)
    d.folders.prune()
    return { freed: sum(items), skipped: playing.size }
  })

  app.delete('/api/storage/music', async () => ({ freed: d.music.files.clear() }))
  app.delete('/api/storage/trailers', async () => ({ freed: d.trailers.cache.clear() }))
}
