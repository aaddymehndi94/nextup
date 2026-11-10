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
