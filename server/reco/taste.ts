import type { TasteFeature, TasteFeatureKind, TasteSignal, TasteSummary } from '../../shared/types.ts'
import { type ContentIndex, splitKey } from './content.ts'
import { joinNames } from './labels.ts'
import { type Affinity, affinities, yearLabel } from './rank.ts'
import { type Signal, signalLabel, strength } from './signals.ts'

// A readable account of what the recommender believes about a profile. Pure.

const KIND: Record<string, TasteFeatureKind> = { g: 'genre', gg: 'genres', gd: 'era', dec: 'decade', d: 'director', w: 'writer', p: 'cast', c: 'country' }
const PEOPLE = new Set(['d', 'w', 'p'])

export const featureKind = (key: string): TasteFeatureKind | undefined => KIND[splitKey(key)[0]]

/** Keys a viewer may boost or block. */
export function isTunableFeature (key: string): boolean {
  const [kind, rest] = splitKey(key)
  return kind in KIND && rest.length > 0 && rest.length <= 120
}

function genresOf (key: string): string[] {
  const [kind, rest] = splitKey(key)
  if (kind === 'g') return [rest]
  if (kind === 'gg') return rest.split('+')
  if (kind === 'gd') return [rest.split('@')[0]]
  return [key]
}

export type TasteCore = Omit<TasteSummary, 'profile' | 'cf'>

export function summarizeTaste (index: ContentIndex, signals: Signal[], prefs: Map<string, 1 | -1>): TasteCore {
  const st = strength(signals)
  const aff = affinities(index, signals)
  const feature = (a: Affinity, neg: boolean): TasteFeature => {
    const key = a.key
    const pref = prefs.get(key)
    return {
      key,
      kind: featureKind(key)!,
      label: index.label(key),
      weight: Math.round((neg ? -1 : 1) * Math.min(1, neg ? a.negScore : a.score) * 100) / 100,
      evidence: (neg ? a.negEvidence : a.evidence).slice(0, 4).map(e => e.name),
      ...(pref ? { pref } : {}),
    }
  }
  const all = [...aff.values()]
  const genreish = (a: Affinity) => !PEOPLE.has(splitKey(a.key)[0]) && splitKey(a.key)[0] !== 'c'
  const likedGenres = all.filter(a => genreish(a) && a.nPos >= 2 && a.lift >= 1.3 && a.score > 0).sort((a, b) => b.score - a.score).slice(0, 6)
  // One entry per person: a writer-director is listed once, as director.
  const roleRank: Record<string, number> = { d: 0, w: 1, p: 2 }
  const seenPeople = new Set<string>()
  const likedPeople = all.filter(a => PEOPLE.has(splitKey(a.key)[0]) && a.score > 0 && (a.nPos >= 2 || (splitKey(a.key)[0] === 'd' && a.explicitP > 0)))
    .sort((a, b) => b.score - a.score || roleRank[splitKey(a.key)[0]] - roleRank[splitKey(b.key)[0]] || b.P - a.P)
    .filter(a => { const name = splitKey(a.key)[1]; if (seenPeople.has(name)) return false; seenPeople.add(name); return true })
    .slice(0, 6)
  const likedCountries = all.filter(a => splitKey(a.key)[0] === 'c' && a.nPos >= 2 && a.lift >= 2 && a.score > 0).sort((a, b) => b.score - a.score).slice(0, 2)
  const negCandidates = all.filter(a => a.nNeg >= 1 && a.negScore > 0 && (genreish(a) ? a.negLift >= 1.3 : a.nNeg >= 2)).sort((a, b) => b.negScore - a.negScore)
  // One disliked title implies a handful of features; show only its two strongest until more agree.
  const disliked = [...negCandidates.filter(a => a.nNeg >= 2), ...negCandidates.filter(a => a.nNeg < 2).slice(0, 2)].slice(0, 6)

  const likes = [...likedGenres, ...likedPeople, ...likedCountries].map(a => feature(a, false))
  const dislikes = disliked.map(a => feature(a, true))
  const prefFeatures: TasteFeature[] = [...prefs].map(([key, value]) => ({
    key, kind: featureKind(key) ?? 'genre', label: index.label(key), weight: value, evidence: [], pref: value,
  }))

  const list: TasteSignal[] = signals.slice(0, 60).map(s => {
    const i = index.indexOf(s.id)
    const it = i === undefined ? undefined : index.item(i)
    return {
      item: { id: s.id, type: s.type, name: it?.name ?? s.id, year: it ? yearLabel(it) : undefined, poster: it?.poster },
      weight: Math.round(s.weight * 100) / 100,
      label: signalLabel(s),
      at: s.at,
    }
  })

  let summary: string
  if (st.coldStart) {
    summary = st.positives
      ? `Getting to know you: ${st.positives} clear like${st.positives > 1 ? 's' : ''} so far. A few more and picks will follow your taste.`
      : 'Nothing to go on yet. Like or dislike a few titles and picks will follow your taste.'
  } else {
    const parts: string[] = []
    // Name distinct tastes: "romantic dramas", not "romantic dramas, romance and 2020s romance".
    const picked: Affinity[] = []
    const covered = new Set<string>()
    for (const a of likedGenres) {
      const genres = genresOf(a.key)
      if (genres.some(g => covered.has(g))) continue
      picked.push(a)
      for (const g of genres) covered.add(g)
      if (picked.length === 3) break
    }
    if (picked.length) parts.push(`You lean towards ${joinNames(picked.map(a => index.label(a.key).toLowerCase()))}`)
    const people = likedPeople.filter(a => a.nPos >= 2)
      .sort((a, b) => Number(b.key.startsWith('d:')) - Number(a.key.startsWith('d:')) || b.score - a.score).slice(0, 3).map(a => index.label(a.key))
    if (people.length) parts.push(`${parts.length ? 'and' : 'You'} come back to ${joinNames(people)}`)
    let s = parts.join(' ') || 'Your likes are broad, so picks lean on what each title is closest to'
    const strongDislikes = disliked.filter(a => a.nNeg >= 2)
    if (strongDislikes.length) s += `. Less keen on ${joinNames(strongDislikes.slice(0, 2).map(a => index.label(a.key).toLowerCase()))}`
    summary = `${s}.`
  }
  return {
    coldStart: st.coldStart,
    confidence: Math.round(st.confidence * 100) / 100,
    counts: { positive: st.positives, negative: st.negatives, total: signals.length },
    summary,
    likes,
    dislikes,
    prefs: prefFeatures,
    signals: list,
  }
}
