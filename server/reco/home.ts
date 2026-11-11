import type { HomeRow, MediaType, RecItem } from '../../shared/types.ts'
import type { Scored } from './cf.ts'
import type { ContentIndex } from './content.ts'
import { decadeOf, joinNames, seriesLabel } from './labels.ts'
import {
  affinities, type Candidate, chooseReason, describeItem, diversify, dupKey, explore, familyOf, freshness, hash01, isRecommendable, popNorm,
  type Prepared, prepare, type RankInput, ratingNorm, reasonOptions, type Seed, scoreAll, seedReasonOptions, toRecItem, topGenreShare,
} from './rank.ts'
import { ACCIDENTAL_SEC, DAY, strength } from './signals.ts'
import type { ItemMeta, ProgressRow, TasteSnapshot } from './types.ts'

// Assembles the home screen, "more like this" and onboarding from scored candidates. Pure.

export interface HomeInput extends RankInput { snapshot: TasteSnapshot }

export interface HomeOutput {
  coldStart: boolean
  /** Every row: the first `firstPage` make the screen, the rest load as the viewer scrolls down. */
  rows: HomeRow[]
  firstPage: number
  /** Titles that were likely on screen on the first page (first few of each recommendation row), for freshness tracking. */
  shown: string[]
}

const ROW = 18
const VISIBLE = 8

/** Titles likely seen in these rows: the first few of each recommendation row. */
export const shownOf = (rows: HomeRow[]): string[] =>
  rows.filter(r => !['continue', 'list', 'onboarding'].includes(r.kind)).flatMap(r => r.items.slice(0, VISIBLE).map(it => it.id))

function minutesLeft (p: ProgressRow): string {
  const m = Math.max(1, Math.round((p.duration - p.position) / 60))
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`
}

function nextEpisode (episodes: Array<[number, number]> | undefined, season: number, episode: number): [number, number] | null {
  if (!episodes) return null
  const i = episodes.findIndex(([s, e]) => s === season && e === episode)
  if (i >= 0) return episodes[i + 1] ?? null
  return episodes.find(([s, e]) => s > season || (s === season && e > episode)) ?? null
}

/** In-progress movies and episodes, and the next episode of a series after a finished one. */
export function continueWatching (index: ContentIndex, snap: TasteSnapshot, now: number): RecItem[] {
  const blocked = new Set([...snap.dismissals.map(d => d.id), ...snap.ratings.filter(r => r.value === -1).map(r => r.id)])
  const byItem = new Map<string, ProgressRow[]>()
  for (const p of snap.progress) {
    if (blocked.has(p.id)) continue
    byItem.set(p.id, [...(byItem.get(p.id) ?? []), p])
  }
  const out: Array<{ at: number; item: RecItem }> = []
  for (const [id, rows] of byItem) {
    const latest = rows.reduce((a, r) => (r.updatedAt > a.updatedAt ? r : a))
    if (latest.hidden || now - latest.updatedAt > 90 * DAY) continue
    const i = index.indexOf(id)
    if (i === undefined) continue
    const it = index.item(i)
    // Under two minutes of real playback is treated as accidental here too.
    const started = latest.watchedSec >= ACCIDENTAL_SEC && latest.duration > 0 && latest.position / latest.duration >= 0.01
    const progress = { streamId: latest.streamId, season: latest.season, episode: latest.episode, position: latest.position, duration: latest.duration, fraction: latest.duration > 0 ? latest.position / latest.duration : 0, completed: latest.completedAt !== undefined, updatedAt: latest.updatedAt }
    if (it.type === 'movie') {
      if (latest.completedAt !== undefined || !started) continue
      out.push({ at: latest.updatedAt, item: { ...toRecItem(it, { kind: 'continue', text: minutesLeft(latest) }), progress, streamId: id } })
      continue
    }
    const se = latest.season !== undefined && latest.episode !== undefined ? `S${latest.season}E${latest.episode}` : ''
    if (latest.completedAt === undefined && started) {
      out.push({ at: latest.updatedAt, item: { ...toRecItem(it, { kind: 'continue', text: `${se} · ${minutesLeft(latest)}` }), progress, streamId: latest.streamId } })
    } else if (latest.completedAt !== undefined && latest.season !== undefined && latest.episode !== undefined) {
      const next = nextEpisode(it.episodes, latest.season, latest.episode)
      const seen = next && rows.some(r => r.season === next[0] && r.episode === next[1] && r.completedAt !== undefined)
      if (!next || seen) continue
      out.push({ at: latest.updatedAt, item: { ...toRecItem(it, { kind: 'continue', text: `Next: S${next[0]}E${next[1]}` }), streamId: `${id}:${next[0]}:${next[1]}` } })
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 20).map(x => x.item)
}

export function myList (index: ContentIndex, snap: TasteSnapshot): RecItem[] {
  return snap.list.flatMap(l => {
    const i = index.indexOf(l.id)
    return i === undefined ? [] : [toRecItem(index.item(i), { kind: 'list', text: describeItem(index.item(i)) })]
  })
}

/** Diverse, well-known titles to rate quickly. Rated and dismissed titles drop out, so it refills as you go. */
export function onboardingItems (index: ContentIndex, snap: TasteSnapshot, now: number, seed: number, k = 24): RecItem[] {
  const done = new Set([...snap.ratings.map(r => r.id), ...snap.dismissals.map(d => d.id)])
  const thisYear = new Date(now).getUTCFullYear()
  const pool: Array<{ i: number; item: ItemMeta; score: number }> = []
  for (let i = 0; i < index.size; i++) {
    const it = index.item(i)
    if (done.has(it.id) || !isRecommendable(it, now) || (it.imdbRating ?? 0) < 7 || !it.year || it.year > thisYear - 1) continue
    if (it.genres.includes('Documentary') || it.genres.includes('Short')) continue
    const fame = ratingNorm(it) * (0.25 + 0.75 * popNorm(it))
    pool.push({ i, item: it, score: fame * (0.85 + 0.3 * hash01(`${seed}:o:${it.id}`)) })
  }
  const nSeries = Math.round(k * 0.3)
  const movies = diversify(index, pool.filter(c => c.item.type === 'movie'), k - nSeries, 0.45, { pool: 220 })
  const series = diversify(index, pool.filter(c => c.item.type === 'series'), nSeries, 0.45, { pool: 100 })
  const out: ItemMeta[] = []
  let m = 0
  let n = 0
  while (out.length < k && (m < movies.length || n < series.length)) {
    if ((out.length % 3 === 2 && n < series.length) || m >= movies.length) out.push(series[n++].item)
    else out.push(movies[m++].item)
  }
  return out.map(it => toRecItem(it, { kind: 'popular', text: describeItem(it) }))
}

function rowItems (cands: Candidate[], reason: (c: Candidate, used: Map<string, number>) => RecItem['reason']): RecItem[] {
  const used = new Map<string, number>()
  return cands.map(c => toRecItem(c.item, reason(c, used)))
}

function becauseTitle (s: Seed): string {
  return s.signal.label === 'liked' ? `Because you liked ${s.name}` : `Because you watched ${s.name}`
}

/** Liked/finished titles to build "Because you liked X" rows around, rotating with the seed. */
function becauseSeeds (p: Prepared, n: number, minWeight: number): Seed[] {
  const { now, seed } = p.input
  return p.pos
    .filter(s => s.signal.weight >= minWeight && ['liked', 'finished', 'episodes'].includes(s.signal.label))
    .map(s => ({ s, v: s.signal.weight * (1 + 0.6 * Math.exp(-(now - s.signal.at) / (30 * DAY))) * (0.5 + hash01(`${seed}:b:${s.signal.id}`)) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, n * 2)
    .map(x => x.s)
}

function becauseRow (p: Prepared, s: Seed, cands: Candidate[], taken: Set<string>, k = ROW - 2, min = 6): HomeRow | null {
  const nb = new Map((p.input.cf?.neighbors.get(s.signal.id) ?? []).map(n => [n.id, n.score]))
  const maxNb = Math.max(1e-9, ...nb.values())
  let maxSim = 1e-9
  for (const c of cands) if (s.sims[c.i] > maxSim) maxSim = s.sims[c.i]
  const pool = cands.filter(c => s.sims[c.i] >= 0.12 || nb.has(c.item.id))
  const seedType = p.input.index.item(s.i).type
  // Close to the seed first, but still a good pick for this profile overall (quality, shape, other likes).
  // Shared genres too: a director's animated comedy isn't "because you liked" their space drama.
  const seedGenres = new Set(p.input.index.item(s.i).genres)
  const genreFit = (it: ItemMeta) => {
    if (!seedGenres.size || !it.genres.length) return 1
    const shared = it.genres.filter(g => seedGenres.has(g)).length
    return 0.5 + 0.5 * shared / new Set([...seedGenres, ...it.genres]).size
  }
  const rel = (c: Candidate) => (0.6 * s.sims[c.i] / maxSim + 0.15 * (nb.get(c.item.id) ?? 0) / maxNb + 0.25 * c.score + (c.item.type === seedType ? 0.08 : 0)) * (0.5 + 0.5 * c.fit) * genreFit(c.item)
  const picks = diversify(p.input.index, pool, k, 0.8, { taken, relevance: rel })
  if (picks.length < min) return null
  return {
    id: `because:${s.signal.id}`,
    kind: 'because',
    title: becauseTitle(s),
    items: rowItems(picks, (c, used) => chooseReason(p, seedReasonOptions(p, s, c), used)),
  }
}

const lc = (s: string) => s.trim().toLowerCase()

function hasFeature (it: ItemMeta, key: string): boolean {
  const kind = key.slice(0, key.indexOf(':'))
  const rest = key.slice(key.indexOf(':') + 1)
  switch (kind) {
    case 'g': return it.genres.includes(rest)
    case 'gg': { const [a, b] = rest.split('+'); return it.genres.includes(a) && it.genres.includes(b) }
    case 'gd': { const [g, d] = rest.split('@'); return it.genres.includes(g) && !!it.year && decadeOf(it.year) === d }
    case 'dec': return !!it.year && decadeOf(it.year) === rest
    case 'd': return it.directors.some(x => lc(x) === rest)
    case 'w': return it.writers.some(x => lc(x) === rest)
    case 'p': return it.cast.some(x => lc(x) === rest)
    case 'c': return it.countries.some(x => lc(x) === rest)
    default: return false
  }
}

function featureTokens (key: string): Set<string> {
  const kind = key.slice(0, key.indexOf(':'))
  const rest = key.slice(key.indexOf(':') + 1)
  return new Set(kind === 'gg' ? rest.split('+') : kind === 'gd' ? rest.split('@') : [rest])
}

const isSubset = (a: Set<string>, b: Set<string>) => [...a].every(x => b.has(x))

/** Rows for features the viewer asked for more of ("More Sci-Fi", "More from Denis Villeneuve"). */
function boostedRows (p: Prepared, cands: Candidate[], taken: Set<string>): HomeRow[] {
  const rows: HomeRow[] = []
  for (const [key, v] of p.input.prefs) {
    if (v !== 1 || rows.length >= 2) continue
    // An explicit request: show the best matches even if another row already has them.
    const picks = diversify(p.input.index, cands.filter(c => hasFeature(c.item, key)), ROW, 0.75)
    if (picks.length < 3) continue
    const kind = key.slice(0, key.indexOf(':'))
    const label = p.input.index.label(key)
    for (const c of picks.slice(0, VISIBLE)) taken.add(c.item.id)
    rows.push({
      id: `genre:${key}`,
      kind: 'genre',
      title: kind === 'd' || kind === 'w' ? `More from ${label}` : kind === 'p' ? `More with ${label}` : `More ${label}`,
      subtitle: 'You asked for more of this',
      items: rowItems(picks, (c, used) => chooseReason(p, reasonOptions(p, c, key), used)),
    })
  }
  return rows
}

/** Genres named by a feature key, without decades ("gd:Sci-Fi@2010s" → Sci-Fi). Drama is too broad to count. */
function genreNames (key: string): string[] {
  return [...featureTokens(key)].filter(t => !/^\d{4}s$/.test(t) && t !== 'Drama')
}

/**
 * Rows for the genres (and genre mixes) running through the likes. With `type`, from the likes of that kind
 * only and filled with that kind only ("Comedy series" for someone whose films are mostly sci-fi).
 * `usedGenres` is shared between calls so the screen shows each genre once, not "Sci-Fi" three ways.
 */
function genreRows (p: Prepared, cands: Candidate[], taken: Set<string>, max: number, boosted: HomeRow[] = [], opts: { type?: MediaType; usedGenres?: Set<string>; skip?: Set<string> } = {}): HomeRow[] {
  const { type } = opts
  const used = opts.usedGenres ?? new Set<string>()
  const affinity = type ? affinities(p.input.index, p.input.signals, type) : p.affinity
  const feats = [...affinity.values()]
    .filter(a => {
      const kind = a.key.slice(0, a.key.indexOf(':'))
      return (kind === 'gg' || kind === 'gd' || kind === 'g') && a.nPos >= (kind === 'g' ? 3 : 2) && a.lift >= 1.25 && a.score > 0
    })
    .sort((a, b) => b.score - a.score)
  const rows: HomeRow[] = []
  const prev: Array<Set<string>> = []
  // A feature that already has its "More …" row doesn't get a plain one too (same id, same titles).
  const tokens: Array<Set<string>> = boosted.map(r => r.id.slice('genre:'.length)).filter(k => /^(gg|gd|g):/.test(k)).map(featureTokens)
  for (const a of feats) {
    if (rows.length >= max) break
    if (boosted.some(r => r.id === `genre:${a.key}`)) continue
    // Once on screen in any form ("Romantic comedy series"), not again lower down as plain "Romantic comedies".
    if (opts.skip && [`genre:${a.key}`, `genre:movie:${a.key}`, `genre:series:${a.key}`].some(id => opts.skip!.has(id))) continue
    // "Romance" adds nothing next to "Romantic dramas"; "80s action" and "Action thrillers" both do.
    const tk = featureTokens(a.key)
    if (tokens.some(t => isSubset(tk, t) || isSubset(t, tk))) continue
    const genres = genreNames(a.key)
    if (genres.some(g => used.has(g))) continue
    const pool = cands.filter(c => (!type || c.item.type === type) && hasFeature(c.item, a.key))
    const picks = byMix(p, pool, ROW, 0.7, taken)
    if (picks.length < 6) continue
    const ids = new Set(picks.slice(0, 10).map(c => c.item.id))
    if (prev.some(s => [...ids].filter(x => s.has(x)).length > 0.5 * ids.size)) continue
    prev.push(ids)
    tokens.push(tk)
    for (const g of genres) used.add(g)
    for (const c of picks.slice(0, VISIBLE)) taken.add(c.item.id)
    const [kind, rest] = [a.key.slice(0, a.key.indexOf(':')), a.key.slice(a.key.indexOf(':') + 1)]
    const like = joinNames(a.evidence.slice(0, 2).map(e => e.name))
    rows.push({
      id: type ? `genre:${type}:${a.key}` : `genre:${a.key}`,
      kind: 'genre',
      title: type === 'series' ? (kind === 'g' ? `${rest} series` : seriesLabel(p.input.index.label(a.key))) : p.input.index.label(a.key),
      subtitle: type === 'series' ? `Series like ${like}` : type === 'movie' ? `Films like ${like}` : `Like ${like}`,
      items: rowItems(picks, (c, used) => chooseReason(p, reasonOptions(p, c, a.key), used)),
    })
  }
  return rows
}

const exploreReason = (it: ItemMeta): RecItem['reason'] => ({
  kind: 'explore',
  text: `Something different · ${it.genres[0]}${it.imdbRating ? ` · IMDb ${it.imdbRating.toFixed(1)}` : ''}`,
})

/** Share of the profile's positive weight on series, and whether both films and series have been liked. */
function typeMix (p: Prepared): { series: number; both: boolean } {
  let movie = 0
  let series = 0
  for (const s of p.pos) {
    if (s.signal.weight < 0.3) continue
    if (p.input.index.item(s.i).type === 'series') series += s.signal.weight
    else movie += s.signal.weight
  }
  return { series: movie + series ? series / (movie + series) : 0, both: movie > 0 && series > 0 }
}

/** Two ranked lists interleaved so that about `share` of the result comes from the second, spread evenly. */
function interleave<T> (a: T[], b: T[], share: number, k: number): T[] {
  const out: T[] = []
  let i = 0
  let j = 0
  while (out.length < k && (i < a.length || j < b.length)) {
    const wantB = j < Math.round((out.length + 1) * share)
    if ((wantB && j < b.length) || i >= a.length) out.push(b[j++])
    else out.push(a[i++])
  }
  return out
}

/** Diversified picks; once both films and series have been liked, the two in proportion to the likes. */
function byMix (p: Prepared, pool: Candidate[], k: number, lambda: number, taken: Set<string>): Candidate[] {
  const mix = typeMix(p)
  if (!mix.both || pool.every(c => c.item.type === pool[0].item.type)) return diversify(p.input.index, pool, k, lambda, { taken })
  const share = Math.min(0.8, Math.max(0.2, mix.series))
  const nSeries = Math.ceil(k * share)
  const movies = diversify(p.input.index, pool.filter(c => c.item.type === 'movie'), k - nSeries + 2, lambda, { taken })
  const series = diversify(p.input.index, pool.filter(c => c.item.type === 'series'), nSeries + 2, lambda, { taken })
  return interleave(movies, series, share, k)
}

/** "Because you liked" seeds, taking turns between films and series (or, in a tab, that kind first). */
function orderSeeds (p: Prepared, seeds: Seed[], only?: MediaType): Seed[] {
  const ty = (s: Seed) => p.input.index.item(s.i).type
  if (only) return [...seeds.filter(s => ty(s) === only), ...seeds.filter(s => ty(s) !== only)]
  const left = [...seeds]
  const out: Seed[] = []
  while (left.length) {
    const last = out.at(-1)
    const j = last ? left.findIndex(s => ty(s) !== ty(last)) : 0
    out.push(left.splice(Math.max(0, j), 1)[0])
  }
  return out
}

/** Films and series picked separately and interleaved two to one, so series' larger popularity numbers can't crowd films out. */
function mixed (p: Prepared, pool: Candidate[], k: number, lambda: number, opts: Parameters<typeof diversify<Candidate>>[4]): Candidate[] {
  const movies = diversify(p.input.index, pool.filter(c => c.item.type === 'movie'), k, lambda, opts)
  const series = diversify(p.input.index, pool.filter(c => c.item.type === 'series'), Math.ceil(k / 3), lambda, opts)
  const out: Candidate[] = []
  while (out.length < k && (movies.length || series.length)) {
    if ((out.length % 3 === 2 && series.length) || !movies.length) out.push(series.shift()!)
    else out.push(movies.shift()!)
  }
  return out
}

/** Quality-weighted popularity: what's popular, but never what's popular and bad. */
const popularScore = (it: ItemMeta) => 0.55 * popNorm(it) + 0.45 * ratingNorm(it)
const popularGate = (it: ItemMeta) => (it.imdbRating !== undefined ? it.imdbRating >= 6.3 : (it.popularity ?? 0) >= 40)

/**
 * Popular titles, quality-weighted. `tilt` leans towards this profile's taste, `fresh` towards the newest
 * (so a film out last week outranks last year's hit of the same standing).
 */
function popularRow (p: Prepared, cands: Candidate[], id: string, title: string, filter: (it: ItemMeta) => boolean, taken: Set<string>, tilt: number, opts: { k?: number; min?: number; fresh?: number } = {}): HomeRow | null {
  const pool = cands.filter(c => filter(c.item) && popularGate(c.item))
  const fresh = opts.fresh ?? 0
  const picks = mixed(p, pool, opts.k ?? ROW, 0.85, { taken, relevance: c => (1 - tilt) * popularScore(c.item) + tilt * c.score + fresh * freshness(c.item, p.input.now) })
  if (picks.length < (opts.min ?? 6)) return null
  const reason = (c: Candidate, used: Map<string, number>) => {
    // Only claim a personal reason when there's a real one; otherwise say what it is.
    const personal = tilt > 0 ? reasonOptions(p, c).filter(o => o.kind === 'person' || o.kind === 'liked' || o.kind === 'cf') : []
    return personal.length ? chooseReason(p, personal, used) : { kind: 'popular' as const, text: describeItem(c.item) }
  }
  return { id, kind: 'popular', title, items: rowItems(picks, reason) }
}

// ---- Discover: kinds of titles this profile hasn't tried -------------------------------------

/** Countries whose films and series nearly every profile already sees plenty of. */
const EVERYWHERE = new Set(['united states', 'united kingdom', 'usa', 'uk'])

/**
 * Genres, genre mixes and countries the likes don't touch yet, with enough well-made titles to show. Each
 * becomes a row with "More like this" and "Not for me": answers that teach the ranker something no amount of
 * watching the usual would. Rotates with the seed so a different few come up over time.
 */
export function discoverFeatures (p: Prepared, cands: Candidate[]): Array<{ key: string; pool: Candidate[] }> {
  const { index, prefs, seed } = p.input
  const shares = topGenreShare(p)
  const byKey = new Map<string, Candidate[]>()
  for (const c of cands) {
    if (c.prior < 0.5 || c.neg >= 0.12) continue
    for (const key of index.features(c.i)) {
      const kind = key.slice(0, key.indexOf(':'))
      if (kind !== 'g' && kind !== 'gg' && kind !== 'c') continue
      const list = byKey.get(key)
      if (list) list.push(c); else byKey.set(key, [c])
    }
  }
  const out: Array<{ key: string; pool: Candidate[]; v: number }> = []
  for (const [key, pool] of byKey) {
    if (pool.length < 10 || prefs.has(key) || (p.affinity.get(key)?.nPos ?? 0) >= 2) continue
    const kind = key.slice(0, key.indexOf(':'))
    const rest = key.slice(key.indexOf(':') + 1)
    if (kind === 'g' && (rest === 'Drama' || (shares.get(rest) ?? 0) >= 0.12)) continue
    if (kind === 'gg' && rest.split('+').every(g => (shares.get(g) ?? 0) >= 0.12)) continue
    if (kind === 'c' && (EVERYWHERE.has(rest) || (p.shape.countries.get(rest) ?? 0) >= 0.08)) continue
    out.push({ key, pool, v: Math.log(pool.length) * (0.4 + 1.2 * hash01(`${seed}:d:${key}`)) })
  }
  return out.sort((a, b) => b.v - a.v)
}

function discoverTitle (p: Prepared, key: string): string {
  const label = p.input.index.label(key)
  return key.startsWith('c:') ? `From ${label}` : label
}

function discoverRow (p: Prepared, key: string, pool: Candidate[], taken: Set<string>, k = ROW, min = 6): HomeRow | null {
  const { now } = p.input
  const picks = mixed(p, pool, k, 0.7, {
    taken,
    relevance: c => 0.45 * popularScore(c.item) + 0.25 * c.fit + 0.2 * c.content + 0.1 * freshness(c.item, now),
  })
  if (picks.length < min) return null
  return {
    id: `discover:${key}`,
    kind: 'discover',
    title: discoverTitle(p, key),
    subtitle: 'New to you. Is it your thing?',
    feature: { key, label: p.input.index.label(key) },
    items: rowItems(picks, c => ({ kind: 'explore', text: describeItem(c.item) })),
  }
}

/**
 * Discover rows, each about something different from the ones before ("Sports films" and "Sports dramas"
 * aren't both shown). `skip` carries row ids and `discover-genre:` entries across calls.
 */
function discoverRows (p: Prepared, cands: Candidate[], taken: Set<string>, n: number, skip: Set<string>): HomeRow[] {
  const rows: HomeRow[] = []
  for (const { key, pool } of discoverFeatures(p, cands)) {
    if (rows.length >= n) break
    if (skip.has(`discover:${key}`)) continue
    const tk = (key.startsWith('gg:') ? key.slice(3).split('+') : key.startsWith('g:') ? [key.slice(2)] : [key]).filter(t => t !== 'Drama').map(t => `discover-genre:${t}`)
    if (tk.some(t => skip.has(t))) continue
    const row = discoverRow(p, key, pool, taken)
    if (!row) continue
    for (const t of tk) skip.add(t)
    skip.add(row.id)
    rows.push(row)
  }
  return rows
}

const SHOWCASE = ['Comedy', 'Thriller', 'Sci-Fi', 'Romance', 'Animation', 'Crime', 'Horror', 'Drama', 'Mystery', 'Fantasy', 'Action', 'Documentary']

/**
 * The home screen. With `only`, the Films or Series tab: the same rows, built from that kind of title, and
 * from the taste shown on that kind (likes of the other kind still help, they just don't dominate).
 */
export function buildHome (input: HomeInput, only?: MediaType): HomeOutput {
  const { index, snapshot: snap, now, seed } = input
  const st = strength(input.signals)
  const listIds = new Set(snap.list.map(l => l.id))
  const p = prepare({ ...input, exclude: new Set([...input.exclude, ...listIds]) })
  if (only) p.affinity = affinities(index, input.signals, only)
  const cands = scoreAll(p, only ? it => it.type === only : undefined)
  const ofType = (it: RecItem) => !only || it.type === only
  const kinds = only === 'series' ? 'series' : only === 'movie' ? 'films' : 'films and series'
  const rows: HomeRow[] = []
  const taken = new Set<string>()
  const add = (row: HomeRow | null) => {
    if (!row) return
    rows.push(row)
    for (const it of row.items.slice(0, VISIBLE)) {
      taken.add(it.id)
      taken.add(`fam:${dupKey(it.name)}`)
    }
  }
  const done = (coldStart: boolean, firstPage: number): HomeOutput => ({ coldStart, rows, firstPage, shown: shownOf(rows.slice(0, firstPage)) })

  // What's out now: last year and this one, the newest first among equals.
  const recent = new Date(now).getUTCFullYear() - 1
  const isNew = (it: ItemMeta) => (it.year ?? 0) >= recent
  const newTitle = only === 'series' ? 'New & popular series' : only === 'movie' ? 'New & popular films' : 'New & popular'

  const cont = continueWatching(index, snap, now).filter(ofType)
  if (cont.length) add({ id: 'continue', kind: 'continue', title: 'Continue watching', items: cont })
  const list = myList(index, snap).filter(ofType)
  if (list.length) add({ id: 'list', kind: 'list', title: 'My List', items: list })

  if (st.coldStart) {
    if (!only) {
      const needed = Math.max(1, 3 - st.positives)
      add({ id: 'onboarding', kind: 'onboarding', title: 'Rate a few to get started', subtitle: `Like ${needed} more and picks will start to follow your taste`, items: onboardingItems(index, snap, now, seed, 16) })
    }
    add(popularRow(p, cands, 'popular', newTitle, isNew, taken, 0, { fresh: 0.35 }))
    for (const s of orderSeeds(p, becauseSeeds(p, 2, 0.3), only).slice(0, 2)) add(becauseRow(p, s, cands, taken))
    if (only !== 'series') add(popularRow(p, cands, 'popular:movie', 'Popular films', it => it.type === 'movie', taken, 0))
    if (only !== 'movie') add(popularRow(p, cands, 'popular:series', 'Popular series', it => it.type === 'series', taken, 0))
    const acclaimed = mixed(p, cands.filter(c => (c.item.imdbRating ?? 0) >= 7.8), ROW, 0.6, { taken, relevance: c => 0.75 * ratingNorm(c.item) + 0.25 * popNorm(c.item) })
    if (acclaimed.length >= 6) add({ id: 'acclaimed', kind: 'acclaimed', title: 'Acclaimed', subtitle: `Highly rated ${kinds}`, items: rowItems(acclaimed, c => ({ kind: 'quality', text: `IMDb ${c.item.imdbRating!.toFixed(1)} · ${describeItem(c.item)}` })) })
    const genres = [...SHOWCASE].sort((a, b) => hash01(`${seed}:${a}`) - hash01(`${seed}:${b}`))
    const showcase = (g: string) => popularRow(p, cands, `showcase:${g}`, only === 'series' ? `${g} series` : index.label(`g:${g}`), it => it.genres.includes(g), taken, 0)
    for (const g of genres.slice(0, only ? 4 : 3)) add(showcase(g))
    const firstPage = rows.length
    // Further down, as the viewer scrolls: the other genres.
    for (const g of genres.slice(only ? 4 : 3)) add(showcase(g))
    return done(true, firstPage)
  }

  // Top picks, with a bounded exploration slot (about 1 in 10). On the mixed home, films and series are ranked
  // apart and shown in proportion to the likes (never under a fifth each once both have been liked).
  const mix = typeMix(p)
  const picks = byMix(p, cands, 22, 0.75, taken)
  const pickIds = new Set(picks.map(c => c.item.id))
  const wild = explore(p, cands, 2, new Set([...taken, ...pickIds]))
  const used = new Map<string, number>()
  const top: RecItem[] = picks.map(c => toRecItem(c.item, chooseReason(p, reasonOptions(p, c), used)))
  wild.forEach((c, j) => top.splice(Math.min(top.length, j === 0 ? 4 : 12), 0, toRecItem(c.item, exploreReason(c.item))))
  add({ id: 'top', kind: 'top', title: 'Top picks for you', items: top })
  for (const it of top.slice(VISIBLE, 16)) taken.add(it.id)

  // High up: what's out now, leaning towards this profile's taste.
  add(popularRow(p, cands, 'popular', newTitle, isNew, taken, 0.4, { fresh: 0.35 }))

  let because = 0
  for (const s of orderSeeds(p, becauseSeeds(p, 4, 0.45), only)) {
    if (because >= (only ? 3 : 2)) break
    const row = becauseRow(p, s, cands, taken)
    if (row) { add(row); because++ }
  }
  const boosted = boostedRows(p, cands, taken)
  for (const row of boosted) add(row)
  const usedGenres = new Set<string>()
  if (only) {
    for (const row of genreRows(p, cands, taken, 4, boosted, { type: only, usedGenres })) add(row)
  } else {
    for (const row of genreRows(p, cands, taken, 2, boosted, { usedGenres })) add(row)
    // Then one row from each kind's own taste, the smaller one first, so a sitcom habit isn't lost under sci-fi films.
    const order: MediaType[] = mix.series < 0.5 ? ['series', 'movie'] : ['movie', 'series']
    for (const ty of order) {
      if (p.pos.filter(s => index.item(s.i).type === ty && s.signal.weight >= 0.3).length < 3) continue
      for (const row of genreRows(p, cands, taken, 1, boosted, { type: ty, usedGenres })) add(row)
    }
  }

  const wide = explore(p, cands, 24, taken)
  const share = Math.min(0.8, Math.max(0.2, mix.series))
  const different = only || !mix.both ? wide.slice(0, 14) : interleave(wide.filter(c => c.item.type === 'movie'), wide.filter(c => c.item.type === 'series'), share, 14)
  if (different.length >= 6) add({ id: 'different', kind: 'different', title: 'Something different', subtitle: 'Highly rated, outside your usual', items: different.map(c => toRecItem(c.item, exploreReason(c.item))) })

  const skip = new Set(rows.map(r => r.id))
  for (const row of discoverRows(p, cands, taken, 1, skip)) add(row)
  if (only) add(popularRow(p, cands, `popular:${only}`, only === 'series' ? 'Popular series' : 'Popular films', () => true, taken, 0.2))
  const firstPage = rows.length

  // Further down, loaded as the viewer scrolls: something new to try, another "Because you liked", another
  // genre from the likes, in turn, until each runs out.
  for (const r of rows) skip.add(r.id)
  const seeds = orderSeeds(p, becauseSeeds(p, 10, 0.3), only)
  const usedMore = new Set<string>()
  for (let round = 0; round < 6; round++) {
    const before = rows.length
    for (const row of discoverRows(p, cands, taken, 1, skip)) { add(row); skip.add(row.id) }
    for (let row: HomeRow | null = null; !row && seeds.length;) {
      const s = seeds.shift()!
      if (skip.has(`because:${s.signal.id}`)) continue
      row = becauseRow(p, s, cands, taken)
      if (row) { add(row); skip.add(row.id) }
    }
    for (const row of genreRows(p, cands, taken, 1, boosted, { type: only, usedGenres: usedMore, skip })) { add(row); skip.add(row.id) }
    if (rows.length === before) break
  }
  return done(false, firstPage)
}

/**
 * More titles for a row the viewer has scrolled to the end of, in the same spirit as the row itself,
 * skipping `have` (what the row already shows) and their families. Empty when the row can't go on.
 */
export function moreForRow (input: HomeInput, rowId: string, have: string[], only?: MediaType, k = ROW): RecItem[] {
  const { index } = input
  const p = prepare({ ...input, exclude: new Set([...input.exclude, ...input.snapshot.list.map(l => l.id)]) })
  if (only) p.affinity = affinities(index, input.signals, only)
  const cands = scoreAll(p, only ? it => it.type === only : undefined)
  const taken = new Set<string>()
  for (const id of have) {
    taken.add(id)
    const i = index.indexOf(id)
    if (i !== undefined) taken.add(`fam:${familyOf(index.item(i))}`)
  }
  const withReasons = (picks: Candidate[], avoid?: string) => {
    const used = new Map<string, number>()
    return picks.map(c => toRecItem(c.item, chooseReason(p, reasonOptions(p, c, avoid), used)))
  }
  const recent = new Date(input.now).getUTCFullYear() - 1
  const cold = strength(input.signals).coldStart
  const sep = rowId.indexOf(':')
  const [kind, rest] = sep < 0 ? [rowId, ''] : [rowId.slice(0, sep), rowId.slice(sep + 1)]
  switch (kind) {
    case 'top': return withReasons(byMix(p, cands, k, 0.75, taken))
    case 'because': {
      const s = p.pos.find(x => x.signal.id === rest)
      return s ? becauseRow(p, s, cands, taken, k, 1)?.items ?? [] : []
    }
    case 'genre': {
      const m = /^(movie|series):(.+)$/.exec(rest)
      const key = m ? m[2] : rest
      const pool = cands.filter(c => (!m || c.item.type === m[1]) && hasFeature(c.item, key))
      return withReasons(byMix(p, pool, k, 0.7, taken), key)
    }
    case 'popular': {
      const filter = rest === 'movie' || rest === 'series' ? (it: ItemMeta) => it.type === rest : (it: ItemMeta) => (it.year ?? 0) >= recent
      const tilt = cold ? 0 : rest ? 0.2 : 0.4
      return popularRow(p, cands, rowId, '', filter, taken, tilt, { k, min: 1, fresh: rest ? 0 : 0.35 })?.items ?? []
    }
    case 'showcase': return popularRow(p, cands, rowId, '', it => it.genres.includes(rest), taken, 0, { k, min: 1 })?.items ?? []
    case 'acclaimed': {
      const picks = mixed(p, cands.filter(c => (c.item.imdbRating ?? 0) >= 7.8), k, 0.6, { taken, relevance: c => 0.75 * ratingNorm(c.item) + 0.25 * popNorm(c.item) })
      return rowItems(picks, c => ({ kind: 'quality', text: `IMDb ${c.item.imdbRating!.toFixed(1)} · ${describeItem(c.item)}` }))
    }
    case 'different': return explore(p, cands, k, taken).map(c => toRecItem(c.item, exploreReason(c.item)))
    case 'discover': return discoverRow(p, rest, cands.filter(c => c.prior >= 0.5 && c.neg < 0.12 && hasFeature(c.item, rest)), taken, k, 1)?.items ?? []
    default: return []
  }
}

export function similarItems (input: RankInput, targetId: string, cfNeighbors: Scored[] | null, k = 20): RecItem[] {
  const { index } = input
  const target = index.indexOf(targetId)
  if (target === undefined) return []
  const p = prepare({ ...input, exclude: new Set([...input.exclude, targetId]) })
  const sims = index.simAll(target)
  const tgt = index.item(target)
  const cfMap = new Map((cfNeighbors ?? []).map(n => [n.id, n.score]))
  const maxCf = Math.max(1e-9, ...cfMap.values())
  const cands = scoreAll(p).filter(c => sims[c.i] >= 0.12 || cfMap.has(c.item.id))
  const maxSim = Math.max(1e-9, ...cands.map(c => sims[c.i]))
  // Same format and a similar standard as the title itself, then the profile's own lean.
  // Unrated (brand-new) titles are a gamble next to a known-good one.
  const ratingFit = (c: Candidate) => c.item.imdbRating === undefined ? 0.4 : tgt.imdbRating === undefined ? 0.8 : Math.max(0, Math.min(1, 1 - Math.max(0, tgt.imdbRating - 0.8 - c.item.imdbRating) / 1.5))
  const rel = (c: Candidate) => (0.55 * sims[c.i] / maxSim + 0.25 * (cfMap.get(c.item.id) ?? 0) / maxCf + 0.1 * c.prior + 0.1 * input.confidence * c.personal) *
    (c.item.type === tgt.type ? 1 : 0.75) * (0.6 + 0.4 * ratingFit(c))
  const picks = diversify(index, cands, k, 0.85, { relevance: rel, maxPerFamily: 2 })
  const seed: Seed = { i: target, name: tgt.name, sims, signal: { id: tgt.id, type: tgt.type, weight: 1, explicit: false, label: 'played', at: input.now } }
  const pseudo: Prepared = { ...p, input: { ...p.input, cf: p.input.cf ? { ...p.input.cf, neighbors: new Map([[tgt.id, cfNeighbors ?? []]]) } : null } }
  const used = new Map<string, number>()
  return picks.map(c => toRecItem(c.item, chooseReason(pseudo, seedReasonOptions(pseudo, seed, c), used, 3)))
}
