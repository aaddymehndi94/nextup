import type { MediaType } from '../../shared/types.ts'
import type { ItemMeta, ItemRef } from '../reco/types.ts'
import type { SearchHit } from '../taste/items.ts'
import type { Suggestion } from './prompts.ts'

// Turns the model's suggestions into catalogue titles. A suggestion is kept only when Cinemeta has a title of
// that name (and, when the model gave one, that year, give or take one): misremembered or invented titles
// are dropped here, so they never reach the screen. Search results carry only a name and year, enough to
// choose; full details are then fetched for the chosen title alone. No model tokens are spent here.

export interface Catalogue {
  lookup (id: string): ItemMeta | undefined
  search (type: MediaType, query: string): Promise<SearchHit[]>
  ensure (refs: ItemRef[]): Promise<void>
}

export interface Resolved { suggestion: Suggestion; item: ItemMeta }

/** "The Office (UK)" → "officeuk", "Amélie" → "amelie", "Fast & Furious" → "fastandfurious". */
export function normTitle (s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/^(the|a|an) /, '').replace(/[^\p{L}\p{N}]+/gu, '')
}

/** How well a catalogue title answers a suggestion: 0 = not it. */
export function matchScore (s: Pick<Suggestion, 'title' | 'year'>, it: { name?: string; year?: number }): number {
  const a = normTitle(s.title)
  const b = normTitle(it.name ?? '')
  if (!a || !b) return 0
  const yearKnown = s.year > 0 && it.year !== undefined
  const yearOk = !yearKnown || Math.abs(it.year! - s.year) <= 1
  if (a === b) return yearOk ? 3 : 1
  // "Shōgun" vs "Shogun (2024)", "Mission: Impossible – Dead Reckoning" vs "… Part One": only with the year.
  const contains = (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))
  return contains && yearKnown && yearOk ? 2 : 0
}

async function resolveOne (cat: Catalogue, s: Suggestion): Promise<ItemMeta | null> {
  // A remembered id is free to check when the title is already known; it must still match the name.
  if (s.imdbId) {
    const known = cat.lookup(s.imdbId)
    if (known && matchScore(s, known) >= 2) return known
  }
  for (const type of [s.type, s.type === 'movie' ? 'series' : 'movie'] as MediaType[]) {
    const hits = await cat.search(type, s.title).catch(() => [] as SearchHit[])
    let best: SearchHit | null = null
    let bestScore = 0
    for (const hit of hits.slice(0, 8)) {
      const score = matchScore(s, hit) + (hit.id === s.imdbId ? 0.5 : 0)
      if (score > bestScore) { best = hit; bestScore = score }
    }
    // An exact name in the wrong year is a remake or namesake: only good enough when the model gave no year.
    if (best && (bestScore >= 2 || (bestScore >= 1 && !s.year))) {
      if (!cat.lookup(best.id)) await cat.ensure([{ id: best.id, type: best.type }]).catch(() => {})
      return cat.lookup(best.id) ?? null
    }
  }
  return null
}

/** Resolves every suggestion (in parallel; the catalogue rate-limits itself), dropping misses and repeats. */
export async function resolveAll (cat: Catalogue, suggestions: Suggestion[]): Promise<Resolved[]> {
  const items = await Promise.all(suggestions.map(s => resolveOne(cat, s)))
  const seen = new Set<string>()
  const out: Resolved[] = []
  suggestions.forEach((s, i) => {
    const it = items[i]
    if (!it || seen.has(it.id)) return
    seen.add(it.id)
    out.push({ suggestion: s, item: it })
  })
  return out
}
