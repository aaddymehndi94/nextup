import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { DownloadFolders } from './folders.ts'
import { registerStorageRoutes, storageReport, type StorageDeps } from './storage.ts'

const KEPT = 'a'.repeat(40)
const PLAYING = 'b'.repeat(40)

function setup () {
  const data = mkdtempSync(join(tmpdir(), 'storage-'))
  const folders = new DownloadFolders(data)
  const put = (path: string, bytes: number) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, Buffer.alloc(bytes, 1)) }
  put(join(folders.current, KEPT, 'Film.mkv'), 9000)
  put(join(folders.current, PLAYING, 'Other.mkv'), 4000)
  put(join(data, 'music', 'audio', 'x.m4a'), 3000)
  put(join(data, 'nexttupp.db'), 2000)
  const entries = [
    { id: `${KEPT}-0`, infoHash: KEPT, fileIdx: 0, fileName: 'Film.mkv', title: 'Film', type: 'movie' as const, imdbId: 'tt1', streamId: 'tt1', addedAt: 1 },
    { id: `${PLAYING}-0`, infoHash: PLAYING, fileIdx: 0, fileName: 'Other.mkv', title: 'Other', type: 'movie' as const, imdbId: 'tt2', streamId: 'tt2', addedAt: 2 },
  ]
  const removed: string[] = []
  const d: StorageDeps = {
    dataDir: data,
    folders,
    library: { list: () => entries.filter(e => !removed.includes(e.id)), remove: async id => { removed.push(id) } },
    cleanup: { streamed: async () => [], remove: async () => null },
    music: { files: { usage: () => ({ bytes: 3000, songs: 1 }), clear: () => 3000 }, dir: join(data, 'music') },
    trailers: { cache: { usage: () => ({ bytes: 0, count: 0 }), clear: () => 0 }, dir: join(data, 'trailers') },
    playing: h => h === PLAYING,
  }
  return { d, removed, data }
}

describe('Storage', () => {
  it('reports each kind of saved content, nexttupp’s own files apart, and the disk', async () => {
    const { d } = setup()
    const r = await storageReport(d, false)
    expect(r.downloads.items.map(i => i.title)).toEqual(['Film', 'Other'])
    expect(r.downloads.bytes).toBeGreaterThanOrEqual(13_000)
    expect(r.music).toMatchObject({ songs: 1 })
    expect(r.music.bytes).toBeGreaterThanOrEqual(3000)
    expect(r.app.bytes).toBeGreaterThanOrEqual(2000) // the database, not the downloads or music
    expect(r.app.bytes).toBeLessThan(9000)
    expect(r.disk!.total).toBeGreaterThan(r.disk!.free)
    expect(r.folder).toMatchObject({ isDefault: true, canChange: false })
  })

  it('deletes every download but the one playing, and keeps the folder for the computer itself', async () => {
    const { d, removed } = setup()
    const app = Fastify()
    registerStorageRoutes(app, d)
    const res = await app.inject({ method: 'DELETE', url: '/api/storage/downloads' })
    expect(res.json()).toMatchObject({ skipped: 1 })
    expect(removed).toEqual([`${KEPT}-0`])
    // inject() comes from 127.0.0.1: allowed. A phone on the Wi-Fi isn't.
    const phone = await app.inject({ method: 'PUT', url: '/api/storage/folder', payload: { path: '/tmp/x' }, remoteAddress: '192.168.1.20' })
    expect(phone.statusCode).toBe(403)
    const bad = await app.inject({ method: 'PUT', url: '/api/storage/folder', payload: { path: 'relative' } })
    expect(bad.statusCode).toBe(400)
  })
})
