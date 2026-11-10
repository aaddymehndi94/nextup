// Collaborative-filtering model for movies, trained offline from MovieLens by scripts/build-cf.py
// (`npm run build:cf`). Method, evaluation and coverage: docs/adr/0002-collaborative-filtering.md.
// Until a model has been built, loadCf resolves to null and the recommender must work from content features alone.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Scored { id: string; score: number }

export interface CfModel {
  /** Number of movies (IMDb ids) the model knows. */
  readonly size: number
  has (imdbId: string): boolean
  /**
   * Movies most similar to this one by co-preference, best first. Empty for unknown ids.
   * Scores are partial correlations in (0, 1] (symmetric, comparable across movies); up to 50 are stored.
   */
  neighbors (imdbId: string, k?: number): Scored[]
  /**
   * Score movies for a taste profile. Seeds are IMDb ids with a weight (negative = disliked).
   * Unknown seed ids are ignored; seeds themselves are excluded from the result. Best first.
   *
   * Scores are Σ weight·B[seed][movie] / Σ|weight| (EASE item weights), so they don't grow with profile size;
   * only movies with a positive score are returned. Best input: liked = 1; middling ratings add nothing (0);
   * disliked -0.5 costs ~2% recall for ~28% fewer picks the user would dislike (numbers in the ADR).
   */
  score (seeds: Array<{ id: string; weight: number }>, k?: number): Scored[]
}

/** File name of the model inside the data directory. */
export const CF_FILE = 'cf.bin'

// Layout (little-endian, every section starts on a 4-byte boundary):
//   'NXCF' · u32 version · u32 header length · header JSON (UTF-8, zero-padded)
//   i32[n]          IMDb ids (numeric part)
//   u32[n + 1]      row pointers of the scoring matrix (CSR; row = seed)
//   u16|u32[nnz]    column indices (width = header.indexBytes), then padding to 4 bytes
//   f32[nnz]        weights
//   u16|u32[n * kn] neighbour indices, best first (0xFFFF / 0xFFFFFFFF = none), then padding
//   f32[n * kn]     neighbour similarities
const MAGIC = 0x4643584e // 'NXCF'
const VERSION = 1

export interface CfHeader {
  n: number
  nnz: number
  kNeighbors: number
  indexBytes: 2 | 4
  method?: string
  [key: string]: unknown
}

const DEFAULT_NEIGHBORS = 20
const DEFAULT_SCORED = 50

export function imdbId (num: number): string {
  return 'tt' + String(num).padStart(7, '0')
}

function align4 (x: number): number {
  return (x + 3) & ~3
}

/** Parse a model file. Throws if the file is malformed. */
export function parseCf (file: Uint8Array): CfModel & { header: CfHeader } {
  // Typed-array views need 4-byte alignment; small Buffers can sit at any offset inside Node's pool.
  const bytes = file.byteOffset % 4 === 0 ? file : new Uint8Array(file)
  const buf = bytes.buffer
  const base = bytes.byteOffset
  const dv = new DataView(buf, base, bytes.byteLength)
  if (bytes.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('cf: not a model file')
  if (dv.getUint32(4, true) !== VERSION) throw new Error(`cf: unsupported version ${dv.getUint32(4, true)}`)
  const hlen = dv.getUint32(8, true)
  if (12 + hlen > bytes.byteLength) throw new Error('cf: truncated header')
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hlen))) as CfHeader
  const { n, nnz, kNeighbors: kn, indexBytes } = header
  for (const v of [n, nnz, kn]) {
    if (!Number.isInteger(v) || v < 0) throw new Error('cf: bad header')
  }
  if (indexBytes !== 2 && indexBytes !== 4) throw new Error('cf: bad index width')
  if (indexBytes === 2 && n > 0xffff) throw new Error('cf: index width too small')

  let off = align4(12 + hlen)
  const take = (len: number): number => {
    const at = off
    off = align4(off + len)
    if (off > bytes.byteLength) throw new Error('cf: truncated')
    return base + at
  }
  const indices = (len: number): Uint16Array | Uint32Array => indexBytes === 2
    ? new Uint16Array(buf, take(2 * len), len)
    : new Uint32Array(buf, take(4 * len), len)
  const none = indexBytes === 2 ? 0xffff : 0xffffffff
  const ids = new Int32Array(buf, take(4 * n), n)
  const ptr = new Uint32Array(buf, take(4 * (n + 1)), n + 1)
  const col = indices(nnz)
  const val = new Float32Array(buf, take(4 * nnz), nnz)
  const nbrIdx = indices(n * kn)
  const nbrVal = new Float32Array(buf, take(4 * n * kn), n * kn)

  if (ptr[0] !== 0 || ptr[n] !== nnz) throw new Error('cf: bad row pointers')
  for (let i = 0; i < n; i++) if (ptr[i] > ptr[i + 1]) throw new Error('cf: bad row pointers')
  for (let p = 0; p < nnz; p++) if (col[p] >= n) throw new Error('cf: index out of range')
  for (let p = 0; p < n * kn; p++) if (nbrIdx[p] >= n && nbrIdx[p] !== none) throw new Error('cf: index out of range')

  const keys: string[] = new Array(n)
  const index = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    keys[i] = imdbId(ids[i])
    index.set(keys[i], i)
  }

  // Scratch accumulator for score(); every call resets what it touched.
  const acc = new Float64Array(n)
  const touched = new Uint8Array(n)

  return {
    header,
    size: n,
    has: (id) => index.has(id),

    neighbors (id, k = DEFAULT_NEIGHBORS) {
      const i = index.get(id)
      if (i === undefined || !(k > 0)) return []
      const out: Scored[] = []
      const end = i * kn + Math.min(kn, Math.floor(k))
      for (let p = i * kn; p < end; p++) {
        if (nbrIdx[p] === none) break
        out.push({ id: keys[nbrIdx[p]], score: nbrVal[p] })
      }
      return out
    },

    score (seeds, k = DEFAULT_SCORED) {
      if (!(k > 0)) return []
      const list: number[] = []
      const isSeed = new Set<number>()
      let total = 0
      for (const { id, weight } of seeds) {
        const i = index.get(id)
        if (i === undefined) continue
        isSeed.add(i)
        if (!Number.isFinite(weight) || weight === 0) continue
        total += Math.abs(weight)
        for (let p = ptr[i]; p < ptr[i + 1]; p++) {
          const j = col[p]
          if (!touched[j]) { touched[j] = 1; list.push(j) }
          acc[j] += weight * val[p]
        }
      }
      const out: Scored[] = []
      for (const j of list) {
        if (acc[j] > 0 && !isSeed.has(j)) out.push({ id: keys[j], score: acc[j] / total })
        acc[j] = 0
        touched[j] = 0
      }
      out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      if (out.length > k) out.length = Math.floor(k)
      return out
    },
  }
}

/**
 * Load the model from the app data directory (`<dataDir>/reco/cf.bin`, where `npm run build:cf` writes it;
 * a directory that holds cf.bin directly also works). Null when no model has been built.
 */
export async function loadCf (dataDir: string): Promise<CfModel | null> {
  for (const path of [join(dataDir, 'reco', CF_FILE), join(dataDir, CF_FILE)]) {
    let file: Buffer
    try {
      file = await readFile(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    return parseCf(file)
  }
  return null
}
