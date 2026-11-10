import type { RecItem, RecReason } from '../../shared/types.ts'
import { type ContentIndex, splitKey } from './content.ts'
import type { Signal } from './signals.ts'
import type { CfData, Impression, ItemMeta } from './types.ts'

// Scoring, diversification and reasons. Pure: all inputs are plain data, `now` and `seed` included.
// See docs/adr/0003 for the weights.

export const BLEND = {
  /** Share of the personal score taken by CF for movies the CF model knows (rest: content). */
  cf: 0.5,
  /** Quality/popularity prior inside a confident personal score. Small on purpose: no engagement bait. */
  prior: 0.12,
  /** Subtracted per unit of (weight × similarity) to the nearest disliked / not-interested title. */
  negative: 0.8,
  /** Added per boosted feature ("more of this"), at most two. Boosted features also get their own row. */
  prefBoost: 0.2,
  /** Max penalty for a title shown many times without being acted on. */
  fatigueMax: 0.15,
  fatiguePerShow: 0.03,
  /** ± half this, deterministic per rotation window, so near-ties rotate instead of freezing. */
  jitter: 0.04,
}

const CONTENT_TOP = [1, 0.5, 0.25]
const MAX_POS_SEEDS = 60
const MAX_NEG_SEEDS = 30
const JUNK_GENRES = new Set(['Talk-Show', 'Reality-TV', 'Game-Show', 'News', 'Adult'])

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** Something we'd put in front of someone: released, has artwork, not a talk show or a short, not dire. */
export function isRecommendable (it: ItemMeta, now: number): boolean {
  if (!it.poster || !it.genres.length) return false
  if (it.genres.some(g => JUNK_GENRES.has(g))) return false
  if (/^untitled\b/i.test(it.name)) return false
  const released = it.released ? Date.parse(it.released) : Number.NaN
  if (Number.isFinite(released)) { if (released > now) return false } else if (!it.year || it.year > new Date(now).getUTCFullYear()) return false
  if (it.type === 'movie' && it.runtime !== undefined && it.runtime < 40) return false
  if (it.imdbRating !== undefined && it.imdbRating < 5) return false
  if (it.imdbRating === undefined && (it.popularity ?? 0) < 3) return false
  return true
}

export const ratingNorm = (it: ItemMeta) => (it.imdbRating !== undefined ? clamp01((it.imdbRating - 5) / 3.5) : 0.35)
export const popNorm = (it: ItemMeta) => (it.popularity !== undefined ? clamp01(Math.log10(1 + it.popularity) / 2.6) : 0.1)

/** Quality first, popularity second: a well-rated film nobody's talking about beats hyped filler. */
export const prior = (it: ItemMeta) => 0.7 * ratingNorm(it) + 0.3 * popNorm(it)

/** FNV-1a → [0, 1). Deterministic stand-in for randomness. */
export function hash01 (s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0) / 4294967296
}

/** Same title family: "Dune" ≈ "Dune: Part Two", "Terminator 2: Judgment Day" ≈ "The Terminator". */
export function dupKey (name: string): string {
  let s = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  s = s.split(/:| - | – /)[0]
  s = s.replace(/^(the|a|an) /, '')
  s = s.replace(/\b(part|chapter|vol\.?|volume)\s+(\w+)\s*$/, '')
  s = s.replace(/\s+(\d+|ii|iii|iv|v|vi)\s*$/, '')
  return s.replace(/[^a-z0-9]+/g, '')
}

const families = new WeakMap<ItemMeta, string>()
/** dupKey of a title, memoised (it runs inside MMR loops). */
export function familyOf (it: ItemMeta): string {
  let f = families.get(it)
  if (f === undefined) { f = dupKey(it.name); families.set(it, f) }
  return f
}

export interface RankInput {
  index: ContentIndex
  /** Strongest first (computeSignals order). */
  signals: Signal[]
  /** Never recommend these. */
  exclude: Set<string>
  prefs: Map<string, 1 | -1>
  cf: CfData | null
  impressions: Map<string, Impression>
  /** 0..1 from strength(). */
  confidence: number
  now: number
  /** Rotation window seed: same seed, same output. */
  seed: number
}

export interface Seed { i: number; signal: Signal; name: string; sims: Float32Array }

export interface Affinity {
  key: string
  /** Positive / negative signal mass carrying this feature. */
  P: number
  N: number
  nPos: number
  nNeg: number
  /** Part of P from explicit likes. */
  explicitP: number
  evidence: Array<{ name: string; w: number }>
  negEvidence: Array<{ name: string; w: number }>
  /** Share of the profile's positive mass with this feature ÷ share of all titles with it. */
  lift: number
  negLift: number
  score: number
  negScore: number
}

export interface Prepared {
  input: RankInput
  pos: Seed[]
  neg: Seed[]
  eligible: Uint8Array
  /** Normalised 0..1. */
  cfScore: Map<string, number>
  cfSeed: Map<string, { seed: Seed; sim: number }>
  affinity: Map<string, Affinity>
  shape: Shape
}

/**
 * What kind of titles the profile likes, beyond genres and people: how well rated, how mainstream,
 * films or series. Content features can't tell Past Lives from a YA romance; these can.
 */
export interface Shape {
  /** Positive seeds the shape is based on. Below 3 it isn't applied. */
  n: number
  /** Weighted mean IMDb rating of liked titles. */
  rating?: number
  /** Weighted mean and spread of log10(1 + popularity). */
  logPop?: number
  logPopSd: number
  /** Share of positive weight per type. */
  movie: number
  series: number
}

export function shapeOf (index: ContentIndex, pos: Seed[]): Shape {
  const seeds = pos.filter(s => s.signal.weight >= 0.3)
  let w = 0; let wr = 0; let r = 0; let wp = 0; let lp = 0; let lp2 = 0; let movie = 0
  for (const s of seeds) {
    const it = index.item(s.i)
    const sw = s.signal.weight
    w += sw
    if (it.type === 'movie') movie += sw
    if (it.imdbRating !== undefined) { wr += sw; r += sw * it.imdbRating }
    if (it.popularity !== undefined) { const x = Math.log10(1 + it.popularity); wp += sw; lp += sw * x; lp2 += sw * x * x }
  }
  const logPop = wp ? lp / wp : undefined
  return {
    n: seeds.length,
    rating: wr ? r / wr : undefined,
    logPop,
    logPopSd: logPop !== undefined ? Math.sqrt(Math.max(0, lp2 / wp - logPop * logPop)) : 0,
    movie: w ? movie / w : 0.5,
    series: w ? 1 - movie / w : 0.5,
  }
}

/** 0..1: how well a title matches the profile's shape. 1 when the shape is unknown. */
export function shapeFit (shape: Shape, it: ItemMeta): number {
  if (shape.n < 3) return 1
  // Rated well below what this profile usually likes; unrated (brand new) titles get a neutral-ish 0.6.
  const ratingFit = shape.rating === undefined ? 1 : it.imdbRating === undefined ? 0.45 : clamp01(1 - Math.max(0, shape.rating - 0.7 - it.imdbRating) / 1.5)
  const sd = Math.max(0.35, shape.logPopSd)
  const popFit = shape.logPop === undefined || it.popularity === undefined ? 0.7 : Math.exp(-((Math.log10(1 + it.popularity) - shape.logPop) ** 2) / (2 * sd * sd))
  const typeFit = ((it.type === 'movie' ? shape.movie : shape.series) + 0.25) / 1.25
  return (0.4 + 0.6 * ratingFit) * (0.65 + 0.35 * popFit) * (0.6 + 0.4 * typeFit)
}

export interface Candidate {
  i: number
  item: ItemMeta
  score: number
  /** Personal part before the prior and confidence mix. */
  personal: number
  content: number
  cf: number
  prior: number
  neg: number
  /** shapeFit: rating level, mainstreamness and format versus the profile's likes. */
  fit: number
  /** Strongest positive seed contributions. */
  top: Array<{ seed: Seed; c: number }>
}

const PERSON = new Set(['d', 'w', 'p'])
const TASTE_KINDS = new Set(['g', 'gg', 'gd', 'd', 'w', 'p', 'c', 'dec'])

/** Which features run through this profile's likes (and dislikes), with evidence. */
export function affinities (index: ContentIndex, signals: Signal[]): Map<string, Affinity> {
  const out = new Map<string, Affinity>()
  let totalP = 0
  let totalN = 0
  for (const s of signals) {
    const i = index.indexOf(s.id)
    if (i === undefined || Math.abs(s.weight) < 0.05) continue
    const name = index.item(i).name
    if (s.weight > 0) totalP += s.weight
    else totalN -= s.weight
    for (const key of index.features(i)) {
      if (!TASTE_KINDS.has(splitKey(key)[0])) continue
      let a = out.get(key)
      if (!a) {
        a = { key, P: 0, N: 0, nPos: 0, nNeg: 0, explicitP: 0, evidence: [], negEvidence: [], lift: 0, negLift: 0, score: 0, negScore: 0 }
        out.set(key, a)
      }
      if (s.weight > 0) {
        a.P += s.weight; a.nPos++; a.evidence.push({ name, w: s.weight })
        if (s.explicit) a.explicitP += s.weight
      } else {
        a.N -= s.weight; a.nNeg++; a.negEvidence.push({ name, w: -s.weight })
      }
    }
  }
  const floor = 1 / Math.max(1, index.size)
  for (const a of out.values()) {
    const kind = splitKey(a.key)[0]
    const df = Math.max(index.docFreq(a.key), floor)
    a.evidence.sort((x, y) => y.w - x.w)
    a.negEvidence.sort((x, y) => y.w - x.w)
    a.lift = totalP ? a.P / totalP / df : 0
    a.negLift = totalN ? a.N / totalN / df : 0
    const purity = (a.P - a.N) / (a.P + a.N + 0.3)
    if (PERSON.has(kind)) {
      a.score = purity * Math.min(1, a.nPos / 2)
      a.negScore = -purity * Math.min(1, a.nNeg / 2)
    } else {
      a.score = purity * (totalP ? a.P / totalP : 0) * Math.log2(Math.max(1, a.lift))
      a.negScore = -purity * (totalN ? a.N / totalN : 0) * Math.log2(Math.max(1, a.negLift))
    }
  }
  return out
}

export function prepare (input: RankInput): Prepared {
  const { index, signals, exclude, prefs, now, cf } = input
  const pos: Seed[] = []
  const neg: Seed[] = []
  for (const s of signals) {
    const i = index.indexOf(s.id)
    if (i === undefined) continue
    if (s.weight > 0.05 && pos.length < MAX_POS_SEEDS) pos.push({ i, signal: s, name: index.item(i).name, sims: index.simAll(i) })
    else if (s.weight < -0.05 && neg.length < MAX_NEG_SEEDS) neg.push({ i, signal: s, name: index.item(i).name, sims: index.simAll(i) })
  }
  const muted = [...prefs].filter(([, v]) => v === -1).map(([k]) => k)
  const eligible = new Uint8Array(index.size)
  for (let i = 0; i < index.size; i++) {
    const it = index.item(i)
    if (exclude.has(it.id) || !isRecommendable(it, now)) continue
    if (muted.length && index.features(i).some(k => muted.includes(k))) continue
    eligible[i] = 1
  }

  const cfScore = new Map<string, number>()
  const cfSeed = new Map<string, { seed: Seed; sim: number }>()
  if (cf?.scores.length) {
    const max = Math.max(...cf.scores.map(s => s.score), 1e-9)
    for (const s of cf.scores) if (s.score > 0) cfScore.set(s.id, s.score / max)
    // For each CF candidate, the liked movie it is most strongly tied to (for the reason line).
    for (const seed of pos) {
      if (seed.signal.weight < 0.3) continue
      for (const n of cf.neighbors.get(seed.signal.id) ?? []) {
        const v = n.score * seed.signal.weight
        const prev = cfSeed.get(n.id)
        if (!prev || v > prev.sim) cfSeed.set(n.id, { seed, sim: v })
      }
    }
  }
  return { input, pos, neg, eligible, cfScore, cfSeed, affinity: affinities(index, signals), shape: shapeOf(index, pos) }
}

/** Every eligible title, scored. Unsorted. */
export function scoreAll (p: Prepared, filter?: (it: ItemMeta) => boolean): Candidate[] {
  const { index, cf, prefs, impressions, confidence, now, seed } = p.input
  const n = index.size
  const t = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const ts = [new Int16Array(n).fill(-1), new Int16Array(n).fill(-1), new Int16Array(n).fill(-1)]
  p.pos.forEach((s, k) => {
    const w = s.signal.weight
    for (let i = 0; i < n; i++) {
      if (!p.eligible[i]) continue
      const c = w * s.sims[i]
      if (c <= t[2][i]) continue
      if (c > t[0][i]) {
        t[2][i] = t[1][i]; ts[2][i] = ts[1][i]; t[1][i] = t[0][i]; ts[1][i] = ts[0][i]; t[0][i] = c; ts[0][i] = k
      } else if (c > t[1][i]) {
        t[2][i] = t[1][i]; ts[2][i] = ts[1][i]; t[1][i] = c; ts[1][i] = k
      } else {
        t[2][i] = c; ts[2][i] = k
      }
    }
  })
  const raw = new Float32Array(n)
  let maxRaw = 0
  for (let i = 0; i < n; i++) {
    if (!p.eligible[i]) continue
    raw[i] = CONTENT_TOP[0] * t[0][i] + CONTENT_TOP[1] * t[1][i] + CONTENT_TOP[2] * t[2][i]
    if (raw[i] > maxRaw) maxRaw = raw[i]
  }
  const boosts = [...prefs].filter(([, v]) => v === 1).map(([k]) => k)
  const useCf = p.cfScore.size > 0
  const out: Candidate[] = []
  for (let i = 0; i < n; i++) {
    if (!p.eligible[i]) continue
    const item = index.item(i)
    if (filter && !filter(item)) continue
    let neg = 0
    for (const s of p.neg) neg = Math.max(neg, -s.signal.weight * s.sims[i])
    const content = maxRaw > 0 ? raw[i] / maxRaw : 0
    const cfv = p.cfScore.get(item.id) ?? 0
    const known = useCf && cf!.known.has(item.id)
    const fit = shapeFit(p.shape, item)
    const personal = (known ? BLEND.cf * cfv + (1 - BLEND.cf) * content : content) * fit - BLEND.negative * neg
    const pr = prior(item)
    let score = confidence * ((1 - BLEND.prior) * personal + BLEND.prior * pr) + (1 - confidence) * pr
    if (boosts.length) score += BLEND.prefBoost * Math.min(2, index.features(i).filter(k => boosts.includes(k)).length)
    const imp = impressions.get(item.id)
    if (imp && imp.count >= 3 && now - imp.lastAt < 21 * 86_400_000) score -= Math.min(BLEND.fatigueMax, BLEND.fatiguePerShow * (imp.count - 2))
    score += (hash01(`${seed}:${item.id}`) - 0.5) * BLEND.jitter
    const top: Candidate['top'] = []
    for (let r = 0; r < 3; r++) if (ts[r][i] >= 0 && t[r][i] > 0) top.push({ seed: p.pos[ts[r][i]], c: t[r][i] })
    out.push({ i, item, score, personal, content, cf: cfv, prior: pr, neg, fit, top })
  }
  return out
}

/**
 * Greedy MMR: each pick maximises λ·relevance − (1−λ)·(max similarity to what's already picked).
 * Titles of the same family (dupKey) are suppressed beyond `maxPerFamily`.
 */
export interface Rankable { i: number; item: ItemMeta; score: number }

export function diversify<T extends Rankable> (index: ContentIndex, cands: T[], k: number, lambda: number, opts: { taken?: Set<string>; relevance?: (c: T) => number; maxPerFamily?: number; pool?: number } = {}): T[] {
  const relOf = opts.relevance ?? (c => c.score)
  // `taken` holds ids and `fam:<dupKey>` entries of titles already on screen in earlier rows.
  const scored: Array<{ c: T; r: number }> = []
  for (const c of cands) {
    if (opts.taken && (opts.taken.has(c.item.id) || opts.taken.has(`fam:${familyOf(c.item)}`))) continue
    scored.push({ c, r: relOf(c) })
  }
  scored.sort((a, b) => b.r - a.r)
  const pool = scored.slice(0, opts.pool ?? 250)
  if (!pool.length) return []
  const hi = pool[0].r
  const lo = pool[pool.length - 1].r
  const span = hi - lo || 1
  const r = pool.map(x => (x.r - lo) / span)
  const fam = pool.map(x => familyOf(x.c.item))
  const maxSim = new Float32Array(pool.length)
  const used = new Uint8Array(pool.length)
  const perFamily = new Map<string, number>()
  const limit = opts.maxPerFamily ?? 1
  const out: T[] = []
  while (out.length < k) {
    let best = -1
    let bestV = -Infinity
    for (let j = 0; j < pool.length; j++) {
      if (used[j] || (perFamily.get(fam[j]) ?? 0) >= limit) continue
      const v = lambda * r[j] - (1 - lambda) * maxSim[j]
      if (v > bestV) { bestV = v; best = j }
    }
    if (best < 0) break
    used[best] = 1
    const c = pool[best].c
    out.push(c)
    perFamily.set(fam[best], (perFamily.get(fam[best]) ?? 0) + 1)
    for (let j = 0; j < pool.length; j++) if (!used[j]) maxSim[j] = Math.max(maxSim[j], index.sim(pool[j].c.i, c.i))
  }
  return out
}

/**
 * Exploration: well-made titles away from the profile's usual genres, but not near anything disliked.
 * Slightly prefers the adjacent (some content overlap) over the random.
 */
export function explore (p: Prepared, cands: Candidate[], k: number, taken: Set<string>): Candidate[] {
  const shares = topGenreShare(p)
  const likedPairs = new Set([...p.affinity.values()].filter(a => a.key.startsWith('gg:') && a.nPos >= 2).map(a => a.key.slice(3)))
  const pool = cands.filter(c => {
    if (taken.has(c.item.id) || c.prior < 0.55 || c.neg >= 0.12) return false
    if ((shares.get(c.item.genres[0]) ?? 0) >= 0.2) return false
    const g = [...c.item.genres].sort()
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (likedPairs.has(`${g[i]}+${g[j]}`)) return false
    return true
  })
  // Adjacent rather than random: some content overlap, made well, the kind of thing this profile watches.
  return diversify(p.input.index, pool, k, 0.45, {
    relevance: c => 0.4 * c.content + 0.3 * c.prior + 0.3 * c.fit + (hash01(`${p.input.seed}:x:${c.item.id}`) - 0.5) * 0.15,
  })
}

/** Share of the profile's positive mass per genre. */
export function topGenreShare (p: Prepared): Map<string, number> {
  const out = new Map<string, number>()
  let total = 0
  for (const s of p.pos) {
    total += s.signal.weight
    for (const g of p.input.index.item(s.i).genres) out.set(g, (out.get(g) ?? 0) + s.signal.weight)
  }
  for (const [g, v] of out) out.set(g, total ? v / total : 0)
  return out
}

// ---- Reasons -------------------------------------------------------------------------------

interface Option { kind: RecReason['kind']; text: string; strength: number; seed?: Seed }

const norm = (s: string) => s.trim().toLowerCase()
const seedRef = (p: Prepared, s: Seed) => ({ id: s.signal.id, type: s.signal.type, name: p.input.index.item(s.i).name })

function seedText (s: Seed): string {
  switch (s.signal.label) {
    case 'liked': return `Because you liked ${s.name}`
    case 'finished': case 'episodes': return `Because you watched ${s.name}`
    case 'watching': return `Because you're watching ${s.name}`
    case 'listed': return `Like ${s.name}, on your list`
    default: return `Similar to ${s.name}`
  }
}

function singular (label: string): string {
  if (label.endsWith('ies')) return `${label.slice(0, -3)}y`
  if (label.endsWith('s') && !label.endsWith('ss')) return label.slice(0, -1)
  return label
}

/** Why this title, for a general row. `avoid` = the row's own feature, already in its title. */
export function reasonOptions (p: Prepared, c: Candidate, avoid?: string): Option[] {
  const { index } = p.input
  const it = c.item
  const opts: Option[] = []
  const aff = (key: string) => p.affinity.get(key)
  for (const d of it.directors) {
    const a = aff(`d:${norm(d)}`)
    if (!a || a.nPos < 1 || a.P <= a.N) continue
    opts.push(a.nPos >= 2 ? { kind: 'person', text: `More from ${d}`, strength: 1.0 } : { kind: 'person', text: `From the director of ${a.evidence[0].name}`, strength: 0.85 })
  }
  for (const w of it.writers.slice(0, 3)) {
    if (it.directors.some(d => norm(d) === norm(w))) continue
    const a = aff(`w:${norm(w)}`)
    if (!a || a.nPos < 1 || a.P <= a.N) continue
    const creator = it.type === 'series' && !it.directors.length
    opts.push(a.nPos >= 2
      ? { kind: 'person', text: creator ? `More from ${w}` : `Written by ${w}`, strength: creator ? 0.95 : 0.75 }
      : { kind: 'person', text: `From the ${creator ? 'creator' : 'writer'} of ${a.evidence[0].name}`, strength: creator ? 0.85 : 0.6 })
  }
  for (const actor of it.cast.slice(0, 3)) {
    const a = aff(`p:${norm(actor)}`)
    if (!a || a.P <= a.N) continue
    if (a.nPos >= 2) opts.push({ kind: 'person', text: `More with ${actor}`, strength: 0.8 })
    else if (c.top[0] && a.evidence[0].name === c.top[0].seed.name) opts.push({ kind: 'person', text: `${actor}, from ${a.evidence[0].name}`, strength: 0.55 })
  }
  const cfs = p.cfSeed.get(it.id)
  if (cfs && c.cf >= 0.35) opts.push({ kind: 'cf', text: `Fans of ${cfs.seed.name} love this`, strength: 0.7 + 0.2 * c.cf, seed: cfs.seed })
  const raw = c.top.reduce((s, x, r) => s + CONTENT_TOP[r] * x.c, 0)
  if (c.top[0] && raw > 0 && c.top[0].c / raw >= 0.4 && c.top[0].c >= 0.15) {
    const s = c.top[0].seed
    opts.push({ kind: 'liked', text: seedText(s), strength: 0.6 + 0.3 * Math.min(1, c.top[0].c / Math.max(0.3, s.signal.weight)), seed: s })
  }
  let bestGenre: { a: Affinity; kind: string } | null = null
  for (const key of index.features(c.i)) {
    const kind = splitKey(key)[0]
    if (key === avoid || !(kind === 'gg' || kind === 'gd' || kind === 'g')) continue
    const a = aff(key)
    if (!a || a.nPos < (kind === 'g' ? 3 : 2) || a.lift < (kind === 'g' ? 2.5 : 1.5) || a.score <= 0) continue
    if (!bestGenre || a.score > bestGenre.a.score) bestGenre = { a, kind }
  }
  if (bestGenre) {
    const label = index.label(bestGenre.a.key)
    const how = bestGenre.a.explicitP / bestGenre.a.P >= 0.5 ? 'you rate highly' : 'you often finish'
    opts.push({ kind: 'genre', text: `${label} ${how}`, strength: 0.5 + 0.2 * Math.min(1, bestGenre.a.nPos / 5) })
  }
  if (it.imdbRating !== undefined && it.imdbRating >= 7.5) opts.push({ kind: 'quality', text: `Highly rated · IMDb ${it.imdbRating.toFixed(1)}`, strength: 0.2 })
  opts.push({ kind: 'popular', text: describeItem(it), strength: 0.1 })
  return opts.sort((a, b) => b.strength - a.strength)
}

/** Why this title, in a row built around one seed title. */
export function seedReasonOptions (p: Prepared, seed: Seed, c: Candidate): Option[] {
  const s = p.input.index.item(seed.i)
  const it = c.item
  const opts: Option[] = []
  const shared = (a: string[], b: string[]) => a.find(x => b.some(y => norm(x) === norm(y)))
  const d = shared(it.directors, s.directors)
  if (d) opts.push({ kind: 'person', text: `Also from ${d}`, strength: 1 })
  const w = shared(it.writers.slice(0, 3), s.writers.slice(0, 3))
  if (w && w !== d) {
    const creator = it.type === 'series' && s.type === 'series'
    opts.push({ kind: 'person', text: creator ? `Also from ${w}` : `Also written by ${w}`, strength: creator ? 1 : 0.8 })
  }
  const a = shared(it.cast.slice(0, 3), s.cast.slice(0, 3))
  if (a) opts.push({ kind: 'person', text: `Also with ${a}`, strength: 0.75 })
  const cfs = p.input.cf?.neighbors.get(seed.signal.id)?.find(n => n.id === it.id)
  if (cfs) opts.push({ kind: 'cf', text: `Fans of ${s.name} love this`, strength: 0.7, seed })
  const features = new Set(p.input.index.features(seed.i))
  let best: { key: string; df: number } | null = null
  for (const key of p.input.index.features(c.i)) {
    const kind = splitKey(key)[0]
    if ((kind !== 'gg' && kind !== 'gd') || !features.has(key)) continue
    const df = p.input.index.docFreq(key)
    if (!best || df < best.df) best = { key, df }
  }
  if (best) {
    const label = p.input.index.label(best.key)
    const text = splitKey(best.key)[0] === 'gd' ? `More ${label}` : `Another ${singular(label).toLowerCase()}`
    opts.push({ kind: 'similar', text, strength: 0.5 })
  }
  opts.push({ kind: 'similar', text: `Similar to ${s.name}`, strength: 0.3 })
  return opts.sort((x, y) => y.strength - x.strength)
}

/**
 * Picks the strongest reason whose wording hasn't been used `limit` times in this row already, so a row
 * doesn't say "Because you liked X" ten times. A shared person is a specific fact and may repeat.
 */
export function chooseReason (p: Prepared, opts: Option[], used: Map<string, number>, limit = 2): RecReason {
  const pick = opts.find(o => o.kind === 'person' || (used.get(o.text) ?? 0) < (o.kind === 'liked' ? limit + 1 : limit)) ?? opts[0]
  used.set(pick.text, (used.get(pick.text) ?? 0) + 1)
  return { kind: pick.kind, text: pick.text, seed: pick.seed ? seedRef(p, pick.seed) : undefined }
}

// ---- Output ---------------------------------------------------------------------------------

export function yearLabel (it: ItemMeta): string | undefined {
  if (it.type === 'series' && it.year) {
    if (it.yearEnd === it.year) return String(it.year)
    return it.yearEnd ? `${it.year}–${it.yearEnd}` : `${it.year}–`
  }
  return it.year ? String(it.year) : undefined
}

export function toRecItem (it: ItemMeta, reason: RecReason): RecItem {
  const description = it.description && it.description.length > 240 ? `${it.description.slice(0, 237).replace(/\s+\S*$/, '')}…` : it.description
  return {
    id: it.id,
    type: it.type,
    name: it.name,
    year: yearLabel(it),
    poster: it.poster,
    background: it.background,
    logo: it.logo,
    description,
    genres: it.genres,
    imdbRating: it.imdbRating?.toFixed(1),
    runtime: it.runtime ? `${it.runtime} min` : undefined,
    reason,
  }
}

export const describeItem = (it: ItemMeta): string => [...it.genres.slice(0, 2), yearLabel(it)].filter(Boolean).join(' · ')
