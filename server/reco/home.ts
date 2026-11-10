import type { HomeRow, RecItem } from '../../shared/types.ts'
import type { Scored } from './cf.ts'
import type { ContentIndex } from './content.ts'
import { decadeOf, joinNames } from './labels.ts'
import {
  type Candidate, chooseReason, describeItem, diversify, dupKey, explore, hash01, isRecommendable, popNorm, type Prepared, prepare,
  type RankInput, ratingNorm, reasonOptions, type Seed, scoreAll, seedReasonOptions, toRecItem,
} from './rank.ts'
import { ACCIDENTAL_SEC, DAY, strength } from './signals.ts'
import type { ItemMeta, ProgressRow, TasteSnapshot } from './types.ts'

// Assembles the home screen, "more like this" and onboarding from scored candidates. Pure.

export interface HomeInput extends RankInput { snapshot: TasteSnapshot }

export interface HomeOutput {
  coldStart: boolean
  rows: HomeRow[]
  /** Titles that were likely on screen (first few of each recommendation row), for freshness tracking. */
  shown: string[]
}

const ROW = 18
const VISIBLE = 8

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

function becauseRow (p: Prepared, s: Seed, cands: Candidate[], taken: Set<string>): HomeRow | null {
  const nb = new Map((p.input.cf?.neighbors.get(s.signal.id) ?? []).map(n => [n.id, n.score]))
  const maxNb = Math.max(1e-9, ...nb.values())
  let maxSim = 1e-9
  for (const c of cands) if (s.sims[c.i] > maxSim) maxSim = s.sims[c.i]
  const pool = cands.filter(c => s.sims[c.i] >= 0.12 || nb.has(c.item.id))
  const seedType = p.input.index.item(s.i).type
  // Close to the seed first, but still a good pick for this profile overall (quality, shape, other likes).
  const rel = (c: Candidate) => (0.6 * s.sims[c.i] / maxSim + 0.15 * (nb.get(c.item.id) ?? 0) / maxNb + 0.25 * c.score + (c.item.type === seedType ? 0.08 : 0)) * (0.5 + 0.5 * c.fit)
  const picks = diversify(p.input.index, pool, ROW - 2, 0.8, { taken, relevance: rel })
  if (picks.length < 6) return null
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

function genreRows (p: Prepared, cands: Candidate[], taken: Set<string>, max: number): HomeRow[] {
  const feats = [...p.affinity.values()]
    .filter(a => {
      const kind = a.key.slice(0, a.key.indexOf(':'))
      return (kind === 'gg' || kind === 'gd' || kind === 'g') && a.nPos >= (kind === 'g' ? 3 : 2) && a.lift >= 1.25 && a.score > 0
    })
    .sort((a, b) => b.score - a.score)
  const rows: HomeRow[] = []
  const prev: Array<Set<string>> = []
  const tokens: Array<Set<string>> = []
  for (const a of feats) {
    if (rows.length >= max) break
    // "Romance" adds nothing next to "Romantic dramas"; "80s action" and "Action thrillers" both do.
    const tk = featureTokens(a.key)
    if (tokens.some(t => isSubset(tk, t) || isSubset(t, tk))) continue
    const pool = cands.filter(c => hasFeature(c.item, a.key))
    const picks = diversify(p.input.index, pool, ROW, 0.7, { taken })
    if (picks.length < 6) continue
    const ids = new Set(picks.slice(0, 10).map(c => c.item.id))
    if (prev.some(s => [...ids].filter(x => s.has(x)).length > 0.5 * ids.size)) continue
    prev.push(ids)
    tokens.push(tk)
    for (const c of picks.slice(0, VISIBLE)) taken.add(c.item.id)
    rows.push({
      id: `genre:${a.key}`,
      kind: 'genre',
      title: p.input.index.label(a.key),
      subtitle: `Like ${joinNames(a.evidence.slice(0, 2).map(e => e.name))}`,
      items: rowItems(picks, (c, used) => chooseReason(p, reasonOptions(p, c, a.key), used)),
    })
  }
  return rows
}

const exploreReason = (it: ItemMeta): RecItem['reason'] => ({
  kind: 'explore',
  text: `Something different · ${it.genres[0]}${it.imdbRating ? ` · IMDb ${it.imdbRating.toFixed(1)}` : ''}`,
})

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

function popularRow (p: Prepared, cands: Candidate[], id: string, title: string, filter: (it: ItemMeta) => boolean, taken: Set<string>, tilt: number): HomeRow | null {
  const pool = cands.filter(c => filter(c.item) && popularGate(c.item))
  const picks = mixed(p, pool, ROW, 0.85, { taken, relevance: c => (1 - tilt) * popularScore(c.item) + tilt * c.score })
  if (picks.length < 6) return null
  const reason = (c: Candidate, used: Map<string, number>) => {
    // Only claim a personal reason when there's a real one; otherwise say what it is.
    const personal = tilt > 0 ? reasonOptions(p, c).filter(o => o.kind === 'person' || o.kind === 'liked' || o.kind === 'cf') : []
    return personal.length ? chooseReason(p, personal, used) : { kind: 'popular' as const, text: describeItem(c.item) }
  }
  return { id, kind: 'popular', title, items: rowItems(picks, reason) }
}

const SHOWCASE = ['Comedy', 'Thriller', 'Sci-Fi', 'Romance', 'Animation', 'Crime', 'Horror', 'Drama', 'Mystery', 'Fantasy', 'Action', 'Documentary']

export function buildHome (input: HomeInput): HomeOutput {
  const { index, snapshot: snap, now, seed } = input
  const st = strength(input.signals)
  const listIds = new Set(snap.list.map(l => l.id))
  const p = prepare({ ...input, exclude: new Set([...input.exclude, ...listIds]) })
  const cands = scoreAll(p)
  const rows: HomeRow[] = []
  const taken = new Set<string>()
  const shown: string[] = []
  const add = (row: HomeRow | null) => {
    if (!row) return
    rows.push(row)
    for (const it of row.items.slice(0, VISIBLE)) {
      taken.add(it.id)
      taken.add(`fam:${dupKey(it.name)}`)
      if (!['continue', 'list', 'onboarding'].includes(row.kind)) shown.push(it.id)
    }
  }

  const cont = continueWatching(index, snap, now)
  if (cont.length) add({ id: 'continue', kind: 'continue', title: 'Continue watching', items: cont })
  const list = myList(index, snap)
  if (list.length) add({ id: 'list', kind: 'list', title: 'My List', items: list })

  if (st.coldStart) {
    const needed = Math.max(1, 3 - st.positives)
    add({ id: 'onboarding', kind: 'onboarding', title: 'Rate a few to get started', subtitle: `Like ${needed} more and picks will start to follow your taste`, items: onboardingItems(index, snap, now, seed, 16) })
    for (const s of becauseSeeds(p, 2, 0.3).slice(0, 2)) add(becauseRow(p, s, cands, taken))
    add(popularRow(p, cands, 'popular:movie', 'Popular films', it => it.type === 'movie', taken, 0))
    add(popularRow(p, cands, 'popular:series', 'Popular series', it => it.type === 'series', taken, 0))
    const acclaimed = mixed(p, cands.filter(c => (c.item.imdbRating ?? 0) >= 7.8), ROW, 0.6, { taken, relevance: c => 0.75 * ratingNorm(c.item) + 0.25 * popNorm(c.item) })
    if (acclaimed.length >= 6) add({ id: 'acclaimed', kind: 'acclaimed', title: 'Acclaimed', subtitle: 'Highly rated films and series', items: rowItems(acclaimed, c => ({ kind: 'quality', text: `IMDb ${c.item.imdbRating!.toFixed(1)} · ${describeItem(c.item)}` })) })
    const genres = [...SHOWCASE].sort((a, b) => hash01(`${seed}:${a}`) - hash01(`${seed}:${b}`)).slice(0, 3)
    for (const g of genres) add(popularRow(p, cands, `showcase:${g}`, index.label(`g:${g}`), it => it.genres.includes(g), taken, 0))
    return { coldStart: true, rows, shown }
  }

  // Top picks, with a bounded exploration slot (about 1 in 10).
  const picks = diversify(index, cands, 22, 0.75, { taken })
  const pickIds = new Set(picks.map(c => c.item.id))
  const wild = explore(p, cands, 2, new Set([...taken, ...pickIds]))
  const used = new Map<string, number>()
  const top: RecItem[] = picks.map(c => toRecItem(c.item, chooseReason(p, reasonOptions(p, c), used)))
  wild.forEach((c, j) => top.splice(Math.min(top.length, j === 0 ? 4 : 12), 0, toRecItem(c.item, exploreReason(c.item))))
  add({ id: 'top', kind: 'top', title: 'Top picks for you', items: top })
  for (const it of top.slice(VISIBLE, 16)) taken.add(it.id)

  let because = 0
  for (const s of becauseSeeds(p, 2, 0.45)) {
    if (because >= 2) break
    const row = becauseRow(p, s, cands, taken)
    if (row) { add(row); because++ }
  }
  for (const row of boostedRows(p, cands, taken)) add(row)
  for (const row of genreRows(p, cands, taken, 3)) add(row)

  // Keep series and films both in view: series rely on content features alone (CF covers movies).
  const seriesShare = picks.filter(c => c.item.type === 'series').length / Math.max(1, picks.length)
  const balance = seriesShare < 0.25 ? 'series' : seriesShare > 0.75 ? 'movie' : null
  if (balance) {
    const pool = cands.filter(c => c.item.type === balance)
    const items = diversify(index, pool, ROW, 0.75, { taken })
    if (items.length >= 6) {
      const u = new Map<string, number>()
      add({ id: balance, kind: balance === 'series' ? 'series' : 'movies', title: balance === 'series' ? 'Series for you' : 'Films for you', items: items.map(c => toRecItem(c.item, chooseReason(p, reasonOptions(p, c), u))) })
    }
  }

  const different = explore(p, cands, 14, taken)
  if (different.length >= 6) add({ id: 'different', kind: 'different', title: 'Something different', subtitle: 'Highly rated, outside your usual', items: different.map(c => toRecItem(c.item, exploreReason(c.item))) })

  const recent = new Date(now).getUTCFullYear() - 1
  add(popularRow(p, cands, 'popular', 'New & popular', it => (it.year ?? 0) >= recent, taken, 0.4))
  return { coldStart: false, rows, shown }
}

/** "More like this" for one title, lightly tilted towards the profile. */
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
