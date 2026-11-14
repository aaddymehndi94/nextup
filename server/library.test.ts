import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Library } from './library.ts'
import type { TorrentEngine } from './engine/engine.ts'

const HASH = 'a'.repeat(40)

/** Just enough engine for the library: open() resolves when the test releases it. */
function fakeEngine () {
  let release!: (fileIdx: number) => void
  const opened = new Promise<number>(resolve => { release = resolve })
  const calls: Array<{ fileIdx?: number; patient?: boolean }> = []
  const pinned: string[] = []
  const abandoned: string[] = []
  const engine = {
    async open (req: { fileIdx?: number }, opts: { patient?: boolean } = {}) {
      calls.push({ fileIdx: req.fileIdx, patient: opts.patient })
      const idx = await opened
      return { id: `${HASH}-${idx}`, file: { name: `Episode ${idx}.mkv` } }
    },
    pin (s: { id: string }) { pinned.push(s.id) },
    unpin () {},
    get () { return undefined },
    list () { return [] },
    async abandon (h: string) { abandoned.push(h) },
    async close () {},
  }
  return { engine: engine as unknown as TorrentEngine, release, calls, pinned, abandoned }
}

const base = { infoHash: HASH, title: "That '70s Show · S1E1", type: 'series' as const, imdbId: 'tt0165598', streamId: 'tt0165598:1:1', addedAt: 1 }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('Library downloads kept from the source list', () => {
  it('saves a pending entry at once, waits patiently, then re-keys it to the real file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-'))
    const f = fakeEngine()
    const lib = new Library(dir, f.engine)
    const entry = lib.download({ ...base, id: `${HASH}-0`, fileIdx: -1, fileName: '' })

    expect(entry.pending).toBe(true)
    expect(lib.list()).toHaveLength(1)
    expect(f.calls).toEqual([{ fileIdx: undefined, patient: true }]) // no hint: let the engine pick the video

    f.release(3)
    await tick()
    const [ready] = lib.list()
    expect(ready.id).toBe(`${HASH}-3`)
    expect(ready.fileIdx).toBe(3)
    expect(ready.fileName).toBe('Episode 3.mkv')
    expect(ready.pending).toBeUndefined()
    expect(f.pinned).toEqual([`${HASH}-3`])

    // Survives a restart as a normal download.
    expect(new Library(dir, fakeEngine().engine).list()[0]).toMatchObject({ id: `${HASH}-3`, fileIdx: 3 })
  })

  it('removing a pending download drops it and abandons the swarm, without pinning later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-'))
    const f = fakeEngine()
    const lib = new Library(dir, f.engine)
    lib.download({ ...base, id: `${HASH}-2`, fileIdx: 2, fileName: 'Episode 2.mkv' })
    await lib.remove(`${HASH}-2`, true)
    expect(f.abandoned).toEqual([HASH])

    f.release(2)
    await tick()
    expect(lib.list()).toHaveLength(0)
    expect(f.pinned).toEqual([])
  })

  it('resumes kept downloads patiently after a restart, so a slow swarm keeps waiting instead of giving up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-'))
    new Library(dir, fakeEngine().engine).add({ ...base, id: `${HASH}-5`, fileIdx: 5, fileName: 'Episode 5.mkv' })
    const f = fakeEngine()
    const lib = new Library(dir, f.engine)
    await lib.resumeAll(() => {})
    expect(f.calls).toEqual([{ fileIdx: 5, patient: true }])
    f.release(5)
    await tick()
    expect(f.pinned).toEqual([`${HASH}-5`])
    expect(lib.list()[0]).toMatchObject({ id: `${HASH}-5`, fileIdx: 5 })
  })
})

describe('Library: pausing a download', () => {
  it('stops it (and its torrent) keeping what is saved, skips it on restart, and carries on when resumed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-'))
    const f = fakeEngine()
    const unloaded: string[] = []
    const unpinned: string[] = []
    const session = { id: `${HASH}-4`, infoHash: HASH, file: { progress: 0.4, length: 2e9, name: 'Episode 4.mkv' } }
    Object.assign(f.engine, {
      get: (id: string) => (id === session.id ? session : undefined),
      unpin: (s: { id: string }) => { unpinned.push(s.id) },
      inUse: () => false,
      unload: async (h: string) => { unloaded.push(h) },
    })
    const lib = new Library(dir, f.engine)
    lib.add({ ...base, id: `${HASH}-4`, fileIdx: 4, fileName: 'Episode 4.mkv' })

    expect(await lib.pause(`${HASH}-4`)).toMatchObject({ paused: true, progress: 0.4, fileSize: 2e9 })
    expect(unpinned).toEqual([`${HASH}-4`])
    expect(unloaded).toEqual([HASH])

    // Paused survives a restart: it isn't opened again.
    const after = fakeEngine()
    const lib2 = new Library(dir, after.engine)
    await lib2.resumeAll(() => {})
    lib2.resumeMissing()
    expect(after.calls).toEqual([])

    expect(lib2.resume(`${HASH}-4`)?.paused).toBeUndefined()
    expect(after.calls).toEqual([{ fileIdx: 4, patient: true }])
    after.release(4)
    await tick()
    expect(after.pinned).toEqual([`${HASH}-4`])
    expect(lib2.list()[0].paused).toBeUndefined()
  })

  it('leaves the torrent running while something plays it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lib-'))
    const f = fakeEngine()
    const unloaded: string[] = []
    const session = { id: `${HASH}-1`, infoHash: HASH, file: { progress: 0.1, length: 1e9, name: 'Episode 1.mkv' } }
    Object.assign(f.engine, { get: () => session, unpin: () => {}, inUse: () => true, unload: async (h: string) => { unloaded.push(h) } })
    const lib = new Library(dir, f.engine)
    lib.add({ ...base, id: `${HASH}-1`, fileIdx: 1, fileName: 'Episode 1.mkv' })
    await lib.pause(`${HASH}-1`)
    expect(unloaded).toEqual([])
  })
})
