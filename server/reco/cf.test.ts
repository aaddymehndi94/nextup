import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CfModel, imdbId, loadCf, parseCf } from './cf.ts'

// tiny-cf.bin is written by `python3 -I scripts/build-cf.py fixture`, the same writer as the real model.
// Items: 0 Shawshank, 1 Godfather, 2 Godfather II, 3 Die Hard, 4 Before Sunrise, 5 tt9999999 (empty).
// Scoring rows (seed → contribution):
//   Shawshank      → Godfather .25, Godfather II .25, Die Hard .125
//   Godfather      → Shawshank .25, Godfather II .5, Before Sunrise -.25
//   Godfather II   → Shawshank .125, Godfather .5
//   Die Hard       → Shawshank .25, Before Sunrise -.5
//   Before Sunrise → Shawshank .125, Die Hard -.25
const FIXTURE = join(import.meta.dirname, '__fixtures__', 'tiny-cf.bin')
const SHAWSHANK = 'tt0111161'
const GODFATHER = 'tt0068646'
const GODFATHER2 = 'tt0071562'
const DIE_HARD = 'tt0095016'
const BEFORE_SUNRISE = 'tt0112471'
const EMPTY = 'tt9999999'

const plain = (xs: Array<{ id: string; score: number }>) => xs.map(x => [x.id, x.score])

describe('loadCf', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'nexttupp-cf-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('returns null when no model has been built', async () => {
    expect(await loadCf(dir)).toBeNull()
    expect(await loadCf(join(dir, 'missing'))).toBeNull()
  })

  it('loads <dataDir>/reco/cf.bin, or cf.bin in the directory given', async () => {
    await mkdir(join(dir, 'reco'))
    await copyFile(FIXTURE, join(dir, 'reco', 'cf.bin'))
    expect((await loadCf(dir))?.size).toBe(6)
    expect((await loadCf(join(dir, 'reco')))?.size).toBe(6)
  })

  it('rejects a corrupt file instead of serving garbage', async () => {
    const bad = join(dir, 'bad')
    await mkdir(bad)
    await writeFile(join(bad, 'cf.bin'), 'not a model')
    await expect(loadCf(bad)).rejects.toThrow(/not a model/)
  })
})

describe('CfModel from the fixture', () => {
  let m: CfModel
  beforeAll(async () => { m = parseCf(await readFile(FIXTURE)) })

  it('knows its ids', () => {
    expect(m.size).toBe(6)
    expect(m.has(GODFATHER)).toBe(true)
    expect(m.has(EMPTY)).toBe(true)
    expect(m.has('tt0000001')).toBe(false)
    expect(m.has('68646')).toBe(false)
  })

  it('neighbors: best first, capped at k, empty for unknown ids', () => {
    expect(plain(m.neighbors(SHAWSHANK))).toEqual([[GODFATHER, 0.75], [GODFATHER2, 0.5], [DIE_HARD, 0.25]])
    expect(plain(m.neighbors(SHAWSHANK, 2))).toEqual([[GODFATHER, 0.75], [GODFATHER2, 0.5]])
    expect(plain(m.neighbors(DIE_HARD))).toEqual([[SHAWSHANK, 0.5]]) // stops at the first empty slot
    expect(m.neighbors(EMPTY)).toEqual([])
    expect(m.neighbors('tt0000001')).toEqual([])
    expect(m.neighbors(SHAWSHANK, 0)).toEqual([])
  })

  it('score: one seed, normalised by total weight, only positive scores', () => {
    expect(plain(m.score([{ id: GODFATHER, weight: 1 }]))).toEqual([[GODFATHER2, 0.5], [SHAWSHANK, 0.25]])
    expect(plain(m.score([{ id: GODFATHER, weight: 4 }]))).toEqual([[GODFATHER2, 0.5], [SHAWSHANK, 0.25]])
  })

  it('score: seeds add up and are excluded from the result', () => {
    // Shawshank .25 + .125, Godfather II .5, Die Hard -.25; total weight 2.
    expect(plain(m.score([{ id: GODFATHER, weight: 1 }, { id: BEFORE_SUNRISE, weight: 1 }])))
      .toEqual([[GODFATHER2, 0.25], [SHAWSHANK, 0.1875]])
  })

  it('score: a negative weight subtracts the seed\'s row', () => {
    // Liking Before Sunrise predicts *not* Die Hard (-.25), so disliking it raises Die Hard.
    expect(plain(m.score([{ id: SHAWSHANK, weight: 1 }, { id: BEFORE_SUNRISE, weight: -1 }])))
      .toEqual([[DIE_HARD, 0.1875], [GODFATHER, 0.125], [GODFATHER2, 0.125]])
    expect(plain(m.score([{ id: DIE_HARD, weight: -1 }]))).toEqual([[BEFORE_SUNRISE, 0.5]])
    // A dislike can push a liked seed's neighbour below zero, which drops it.
    expect(plain(m.score([{ id: GODFATHER2, weight: 1 }, { id: SHAWSHANK, weight: -1 }])))
      .toEqual([[GODFATHER, 0.125]])
  })

  it('score: unknown ids are ignored, zero-weight seeds are still excluded', () => {
    expect(plain(m.score([{ id: 'tt0000001', weight: 5 }, { id: GODFATHER, weight: 1 }])))
      .toEqual([[GODFATHER2, 0.5], [SHAWSHANK, 0.25]])
    expect(plain(m.score([{ id: GODFATHER, weight: 1 }, { id: GODFATHER2, weight: 0 }])))
      .toEqual([[SHAWSHANK, 0.25]])
    expect(plain(m.score([{ id: GODFATHER, weight: 1 }, { id: SHAWSHANK, weight: Number.NaN }])))
      .toEqual([[GODFATHER2, 0.5]])
  })

  it('score: empty, unknown-only and k', () => {
    expect(m.score([])).toEqual([])
    expect(m.score([{ id: 'tt0000001', weight: 1 }])).toEqual([])
    expect(m.score([{ id: EMPTY, weight: 1 }])).toEqual([])
    expect(plain(m.score([{ id: GODFATHER, weight: 1 }], 1))).toEqual([[GODFATHER2, 0.5]])
    expect(m.score([{ id: GODFATHER, weight: 1 }], 0)).toEqual([])
  })

  it('score: calls don\'t leak state into each other', () => {
    const a = m.score([{ id: SHAWSHANK, weight: 1 }])
    m.score([{ id: DIE_HARD, weight: 3 }, { id: GODFATHER, weight: 2 }])
    expect(m.score([{ id: SHAWSHANK, weight: 1 }])).toEqual(a)
  })
})

/** Same layout as scripts/build-cf.py write_model, with 32-bit indices (used when a model has > 65535 items). */
function encode (ids: number[], rows: Array<Array<[number, number]>>, nbrs: Array<Array<[number, number]>>, kn: number,
  patch: Record<string, unknown> = {}): Uint8Array {
  const n = ids.length
  const nnz = rows.reduce((a, r) => a + r.length, 0)
  const header = new TextEncoder().encode(JSON.stringify({ n, nnz, kNeighbors: kn, indexBytes: 4, ...patch }))
  const words = (12 + header.length + 3 >> 2) + n + (n + 1) + 2 * nnz + 2 * n * kn
  const out = new Uint8Array(words * 4)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x4643584e, true)
  dv.setUint32(4, 1, true)
  dv.setUint32(8, header.length, true)
  out.set(header, 12)
  let off = (12 + header.length + 3) & ~3
  const u32 = (v: number) => { dv.setUint32(off, v, true); off += 4 }
  const f32 = (v: number) => { dv.setFloat32(off, v, true); off += 4 }
  for (const id of ids) u32(id)
  let p = 0
  u32(0)
  for (const r of rows) u32(p += r.length)
  for (const r of rows) for (const [j] of r) u32(j)
  for (const r of rows) for (const [, w] of r) f32(w)
  for (const r of nbrs) for (let t = 0; t < kn; t++) u32(r[t]?.[0] ?? 0xffffffff)
  for (const r of nbrs) for (let t = 0; t < kn; t++) f32(r[t]?.[1] ?? 0)
  return out
}

describe('parseCf', () => {
  it('reads 32-bit indices and ids of any length', () => {
    const m = parseCf(encode([1, 10872600, 133093], [[[1, 0.5], [2, 0.25]], [], [[0, 1]]], [[[2, 0.9]], [], []], 2))
    expect(m.has('tt0000001')).toBe(true)
    expect(m.has('tt10872600')).toBe(true)
    expect(m.has('tt0133093')).toBe(true)
    expect(plain(m.score([{ id: 'tt0000001', weight: 2 }]))).toEqual([['tt10872600', 0.5], ['tt0133093', 0.25]])
    expect(plain(m.neighbors('tt0000001'))).toEqual([['tt0133093', 0.8999999761581421]])
  })

  it('works on a buffer that is not 4-byte aligned', () => {
    const raw = encode([1, 2], [[[1, 1]], []], [[], []], 1)
    const shifted = new Uint8Array(raw.length + 1).subarray(1)
    shifted.set(raw)
    expect(plain(parseCf(shifted).score([{ id: 'tt0000001', weight: 1 }]))).toEqual([['tt0000002', 1]])
  })

  it('rejects malformed files', () => {
    const good = encode([1, 2], [[[1, 1]], []], [[[1, 1]], []], 1)
    expect(() => parseCf(good.subarray(0, good.length - 4))).toThrow(/truncated/)
    const badMagic = good.slice()
    badMagic[0] = 0
    expect(() => parseCf(badMagic)).toThrow(/not a model/)
    expect(() => parseCf(encode([1, 2], [[[2, 1]], []], [[], []], 1))).toThrow(/out of range/)
    expect(() => parseCf(encode([1, 2], [[[1, 1]], []], [[[5, 1]], []], 1))).toThrow(/out of range/)
    expect(() => parseCf(encode([1], [[]], [[]], 0, { indexBytes: 3 }))).toThrow(/index width/)
    expect(() => parseCf(encode([1], [[]], [[]], 0, { n: -1 }))).toThrow(/bad header/)
  })

  it('formats ids like IMDb', () => {
    expect(imdbId(68646)).toBe('tt0068646')
    expect(imdbId(10872600)).toBe('tt10872600')
  })
})

// Smoke test against the real model when one has been built locally (npm run build:cf); skipped otherwise.
const REAL = join(import.meta.dirname, '..', '..', 'data', 'reco', 'cf.bin')
describe.skipIf(!existsSync(REAL))('built MovieLens model', () => {
  it('loads quickly and gives sensible neighbours', async () => {
    const t0 = performance.now()
    const m = await loadCf(join(import.meta.dirname, '..', '..', 'data'))
    const ms = performance.now() - t0
    expect(m).not.toBeNull()
    expect(ms).toBeLessThan(2000)
    expect(m!.size).toBeGreaterThan(10000)
    expect(m!.neighbors('tt0068646', 5).map(n => n.id)).toContain('tt0071562') // Godfather → Part II
    expect(m!.neighbors('tt0095016', 10).map(n => n.id)).toContain('tt0099423') // Die Hard → Die Hard 2
    const recs = m!.score([{ id: 'tt0245429', weight: 1 }, { id: 'tt0096283', weight: 1 }], 20).map(r => r.id)
    expect(recs).toContain('tt0119698') // Spirited Away + My Neighbor Totoro → Princess Mononoke
  })
})
