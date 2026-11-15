import { useSyncExternalStore } from 'react'
import { getActiveProfile } from './api.ts'

// "IMDb 7+": hides titles rated below a minimum from search results and the recommendation rows as you scroll
// (not from Continue watching or My List, which are yours). Kept per profile, in this browser.

export const MIN_RATINGS = [0, 6, 7, 8] as const
export type MinRating = typeof MIN_RATINGS[number]

const listeners = new Set<() => void>()
const key = () => `nexttupp:min-rating:${getActiveProfile() ?? 'default'}`

export function minRating (): MinRating {
  try {
    const n = Number(localStorage.getItem(key()))
    return (MIN_RATINGS as readonly number[]).includes(n) ? n as MinRating : 0
  } catch { return 0 }
}

export function setMinRating (n: MinRating): void {
  try { if (n) localStorage.setItem(key(), String(n)); else localStorage.removeItem(key()) } catch { /* this visit only */ }
  cache = { k: key(), v: n }
  for (const l of listeners) l()
}

let cache: { k: string; v: MinRating } | null = null
/** Read once per profile: switching profile reads that profile's own minimum. */
const read = (): MinRating => {
  const k = key()
  if (cache?.k !== k) cache = { k, v: minRating() }
  return cache.v
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export const useMinRating = (): MinRating => useSyncExternalStore(subscribe, read)

/** Whether a title clears the minimum. With a minimum set, a title without a rating doesn't. */
export function clears (title: { imdbRating?: string }, min: MinRating): boolean {
  if (!min) return true
  const r = Number.parseFloat(title.imdbRating ?? '')
  return Number.isFinite(r) && r >= min
}
