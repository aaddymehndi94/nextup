import { decadeOf, eraLabel, genrePlural, pairLabel } from './labels.ts'
import type { ItemMeta } from './types.ts'

// Content similarity: each title becomes a sparse TF-IDF vector over its genres (and genre pairs),
// people, country, era and description terms. Each field group is normalised on its own and scaled by a
// group weight, so a long synopsis can't outvote a shared director. Cosine similarity via an inverted
// index. Pure.

/** Field-group weights (relative). Kept in one place so the ADR and tests can refer to them. */
export const GROUP_WEIGHTS: Record<string, number> = {
  g: 0.8, // genre
  gg: 0.7, // genre pair, e.g. Drama+Romance (the mix says more than the parts)
  gd: 0.35, // genre in a decade, e.g. Action@1980s
  d: 1.0, // director
  w: 0.6, // writer
  p: 0.75, // cast (billing-weighted)
  c: 0.4, // country
  dec: 0.35, // decade (neighbours at partial weight)
  t: 0.7, // description terms
  ty: 0.45, // movie / series
}

/**
 * Added (in IDF units) to each group's norm before normalising, like a phantom feature: a title whose
 * only genre is the very common "Drama" then gets a modest genre weight instead of the whole budget,
 * while a rare director still gets nearly all of the director budget.
 */
export const GROUP_SMOOTHING = 2

export type FeatureGroup = keyof typeof GROUP_WEIGHTS
const GROUPS = Object.keys(GROUP_WEIGHTS)
const GROUP_INDEX: Record<string, number> = Object.fromEntries(GROUPS.map((g, i) => [g, i]))

const STOP = new Set(`a about above after again against all also am an and any are as at be because been before being below
between both but by can could did do does doing down during each even ever every few for from further get gets getting had has
have having he her here hers herself him himself his how however i if in into is it its itself just let lets like make makes
many may me might more most much must my myself never new no nor not now of off on once one only or other our ours out over own
same she should so some such than that the their theirs them themselves then there these they this those through to too two
three under until up upon very was we were what when where which while who whom whose why will with within without would yet
you your yours film films movie movies story series season seasons episode show shows tells follows follow following set based
life lives find finds found must take takes taking become becomes becoming year years day days time times way world people
another together around away back begin begins soon still where something someone along across turn turns turned meet meets
come comes coming goes going help helps known well good great best first last long little old young man men woman women
girl girls boy boys family families friend friends home must called discover discovers decide decides`.split(/\s+/))

function stem (w: string): string {
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1)
  return w
}

export function terms (text: string | undefined): Map<string, number> {
  const out = new Map<string, number>()
  if (!text) return out
  for (const raw of text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/)) {
    if (raw.length < 4 || STOP.has(raw)) continue
    const t = stem(raw)
    if (STOP.has(t)) continue
    out.set(t, (out.get(t) ?? 0) + 1)
  }
  return out
}

const norm = (name: string) => name.trim().toLowerCase()

/** Raw (feature key, group, term frequency) triples for one title, before IDF. */
export function rawFeatures (it: ItemMeta): Array<[string, FeatureGroup, number]> {
  const out: Array<[string, FeatureGroup, number]> = []
  const genres = [...new Set(it.genres)]
  for (const g of genres) out.push([`g:${g}`, 'g', 1])
  const sorted = [...genres].sort()
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) out.push([`gg:${sorted[i]}+${sorted[j]}`, 'gg', 1])
  }
  if (it.year) {
    const dec = decadeOf(it.year)
    out.push([`dec:${dec}`, 'dec', 1])
    out.push([`dec:${decadeOf(it.year - 10)}`, 'dec', 0.35])
    out.push([`dec:${decadeOf(it.year + 10)}`, 'dec', 0.35])
    for (const g of genres) out.push([`gd:${g}@${dec}`, 'gd', 1])
  }
  for (const d of it.directors.slice(0, 3)) out.push([`d:${norm(d)}`, 'd', 1])
  // For series Cinemeta's "writer" is the creator/showrunner: weigh it like a film's director.
  const writerGroup: FeatureGroup = it.type === 'series' && !it.directors.length ? 'd' : 'w'
  for (const w of it.writers.slice(0, 4)) out.push([`w:${norm(w)}`, writerGroup, 1])
  it.cast.slice(0, 5).forEach((p, i) => out.push([`p:${norm(p)}`, 'p', Math.max(0.5, 1 - 0.2 * i)]))
  for (const c of it.countries.slice(0, 3)) out.push([`c:${norm(c)}`, 'c', 1])
  for (const [t, tf] of terms(it.description)) out.push([`t:${t}`, 't', (tf * 2.2) / (tf + 1.2)])
  out.push([`ty:${it.type}`, 'ty', 1])
  return out
}

const featureCache = new WeakMap<ItemMeta, Array<[string, FeatureGroup, number]>>()
/** rawFeatures sorted by key, memoised per item object (the item cache keeps objects stable between rebuilds). */
function featuresOf (it: ItemMeta): Array<[string, FeatureGroup, number]> {
  let f = featureCache.get(it)
  if (!f) { f = rawFeatures(it).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); featureCache.set(it, f) }
  return f
}

export interface SparseVec { f: Int32Array; w: Float32Array }

export class ContentIndex {
  readonly items: ItemMeta[]
  private readonly pos = new Map<string, number>()
  private readonly keys: string[] = []
  private readonly keyIdx = new Map<string, number>()
  private readonly dfs: number[] = []
  private readonly vecs: SparseVec[] = []
  private readonly postItems: Int32Array[] = []
  private readonly postW: Float32Array[] = []
  private readonly labels = new Map<string, string>()

  constructor (items: ItemMeta[]) {
    this.items = items
    items.forEach((it, i) => this.pos.set(it.id, i))
    const raw = items.map(featuresOf)
    const df = new Map<string, number>()
    for (const feats of raw) {
      // Keys repeat within a title only for neighbouring decades; count each once.
      let prev = ''
      for (const [k] of feats) if (k !== prev) { df.set(k, (df.get(k) ?? 0) + 1); prev = k }
    }
    const n = items.length
    // Terms seen once can't match anything; very common ones say nothing.
    const keep = (k: string, d: number) => !k.startsWith('t:') || (d >= 2 && d <= Math.max(3, n * 0.08))
    for (const it of items) this.learnLabels(it)

    const counts: number[] = []
    const groupSq = new Float64Array(GROUPS.length)
    for (const feats of raw) {
      const idxs: number[] = []
      const gs: number[] = []
      const vs: number[] = []
      groupSq.fill(0)
      for (const [k, g, tf] of feats) {
        const d = df.get(k)!
        if (!keep(k, d)) continue
        let idx = this.keyIdx.get(k)
        if (idx === undefined) {
          idx = this.keys.length
          this.keys.push(k)
          this.keyIdx.set(k, idx)
          this.dfs.push(d)
          counts.push(0)
        }
        const v = tf * (Math.log((n + 1) / (d + 1)) + 1)
        const at = idxs.indexOf(idx)
        const gi = GROUP_INDEX[g]
        if (at >= 0) {
          if (v <= vs[at]) continue
          groupSq[gi] += v * v - vs[at] * vs[at]
          vs[at] = v
          continue
        }
        idxs.push(idx); gs.push(gi); vs.push(v)
        groupSq[gi] += v * v
      }
      const entries: Array<[number, number]> = []
      let total = 0
      for (let j = 0; j < idxs.length; j++) {
        const w = (vs[j] / Math.sqrt(groupSq[gs[j]] + GROUP_SMOOTHING ** 2)) * GROUP_WEIGHTS[GROUPS[gs[j]]]
        entries.push([idxs[j], w])
        total += w * w
      }
      const len = Math.sqrt(total) || 1
      entries.sort((a, b) => a[0] - b[0])
      const vec: SparseVec = { f: Int32Array.from(entries, e => e[0]), w: Float32Array.from(entries, e => e[1] / len) }
      for (const idx of vec.f) counts[idx]++
      this.vecs.push(vec)
    }
    for (let k = 0; k < this.keys.length; k++) {
      this.postItems.push(new Int32Array(counts[k]))
      this.postW.push(new Float32Array(counts[k]))
    }
    const fill = new Array<number>(this.keys.length).fill(0)
    this.vecs.forEach((v, i) => {
      for (let j = 0; j < v.f.length; j++) {
        const k = v.f[j]
        this.postItems[k][fill[k]] = i
        this.postW[k][fill[k]] = v.w[j]
        fill[k]++
      }
    })
  }

  private learnLabels (it: ItemMeta): void {
    const set = (k: string, v: string) => { if (!this.labels.has(k)) this.labels.set(k, v) }
    for (const d of it.directors) set(`d:${norm(d)}`, d)
    for (const w of it.writers) set(`w:${norm(w)}`, w)
    for (const p of it.cast) set(`p:${norm(p)}`, p)
    for (const c of it.countries) set(`c:${norm(c)}`, c)
  }

  get size (): number { return this.items.length }
  get featureCount (): number { return this.keys.length }

  indexOf (id: string): number | undefined { return this.pos.get(id) }
  item (i: number): ItemMeta { return this.items[i] }
  vector (i: number): SparseVec { return this.vecs[i] }

  /** Fraction of titles that have this feature (0 when unknown). */
  docFreq (key: string): number {
    const k = this.keyIdx.get(key)
    return k === undefined ? 0 : this.dfs[k] / Math.max(1, this.items.length)
  }

  /** Feature keys of a title (after vocabulary pruning). */
  features (i: number): string[] {
    return Array.from(this.vecs[i].f, k => this.keys[k])
  }

  /** Cosine similarity of title i with every title. */
  simAll (i: number): Float32Array {
    return this.simVec(this.vecs[i])
  }

  simVec (v: SparseVec): Float32Array {
    const out = new Float32Array(this.items.length)
    for (let j = 0; j < v.f.length; j++) {
      const items = this.postItems[v.f[j]]
      const ws = this.postW[v.f[j]]
      const w = v.w[j]
      for (let p = 0; p < items.length; p++) out[items[p]] += w * ws[p]
    }
    return out
  }

  sim (a: number, b: number): number {
    const x = this.vecs[a]
    const y = this.vecs[b]
    let i = 0
    let j = 0
    let s = 0
    while (i < x.f.length && j < y.f.length) {
      if (x.f[i] === y.f[j]) { s += x.w[i] * y.w[j]; i++; j++ } else if (x.f[i] < y.f[j]) i++
      else j++
    }
    return s
  }

  /** Display label for a feature key ("d:denis villeneuve" → "Denis Villeneuve", "gg:Drama+Romance" → "Romantic dramas"). */
  label (key: string): string {
    const [kind, rest] = splitKey(key)
    switch (kind) {
      case 'g': return genrePlural(rest)
      case 'gg': { const [a, b] = rest.split('+'); return pairLabel(a, b) }
      case 'gd': { const [g, d] = rest.split('@'); return eraLabel(g, d) }
      case 'dec': return `Films from the ${rest}`
      default: return this.labels.get(key) ?? rest
    }
  }
}

export function splitKey (key: string): [string, string] {
  const i = key.indexOf(':')
  return [key.slice(0, i), key.slice(i + 1)]
}
