import type { MediaType, TitleSummary } from '../../shared/types.ts'

// IMDb ratings for titles that come from Cinemeta without one (search, the popular rows): from this computer's
// own copy of each title (taste/items.ts), fetching the ones it lacks, for at most `waitMs`.

export interface RatedItems {
  lookup (id: string): { imdbRating?: number } | undefined
  ensure (refs: Array<{ id: string; type: MediaType }>): Promise<void>
}

export async function withRatings<T extends TitleSummary> (titles: T[], items: RatedItems, waitMs = 1500): Promise<T[]> {
  const missing = titles.filter(t => !items.lookup(t.id)).map(t => ({ id: t.id, type: t.type }))
  if (missing.length) {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      items.ensure(missing).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, waitMs) }),
    ])
    clearTimeout(timer)
  }
  return titles.map(t => {
    const r = items.lookup(t.id)?.imdbRating
    return r ? { ...t, imdbRating: r.toFixed(1) } : t
  })
}
