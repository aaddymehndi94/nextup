import { readKey, writeKey } from './storage.ts'

// Home's billboard takes turns among the strongest picks, so it doesn't open on the same film every time while
// taste stays the same. What it showed lately is kept per profile (in memory only in private mode).

/** How many of the top picks take turns. */
export const BILLBOARD_POOL = 8

/** The first of the top picks not featured lately; once all have been, the one featured longest ago. */
export function chooseFeatured<T extends { id: string }> (candidates: T[], recent: string[]): T | null {
  const pool = candidates.slice(0, BILLBOARD_POOL)
  return pool.find(c => !recent.includes(c.id))
    ?? [...pool].sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id))[0]
    ?? null
}

/** `recent` with `id` as the newest, kept short. */
export function rememberFeatured (recent: string[], id: string): string[] {
  return [...recent.filter(x => x !== id), id].slice(-2 * BILLBOARD_POOL)
}

const key = (profile: string | null) => `billboard:${profile ?? 'default'}`

export function featuredLately (profile: string | null): string[] {
  try {
    const v = JSON.parse(readKey(key(profile)) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function markFeatured (profile: string | null, id: string): void {
  writeKey(key(profile), JSON.stringify(rememberFeatured(featuredLately(profile), id)))
}
