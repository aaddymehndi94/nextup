import { describe, expect, it } from 'vitest'
import type { TitleSummary } from '../../shared/types.ts'
import { withRatings } from './ratings.ts'

// Search and the popular rows come from Cinemeta without ratings; the computer's own copy of each title has
// its IMDb rating, so they're filled in from there, fetching the titles it doesn't have yet, briefly.

const titles: TitleSummary[] = [
  { id: 'tt0113277', type: 'movie', name: 'Heat' },
  { id: 'tt0097493', type: 'movie', name: 'Heathers' },
]

function items (known: Record<string, number>, fetched: Record<string, number> = {}, delayMs = 0) {
  const have = new Map(Object.entries(known))
  return {
    asked: [] as string[],
    lookup (id: string) { return have.has(id) ? { imdbRating: have.get(id) } : undefined },
    async ensure (refs: Array<{ id: string }>) {
      this.asked.push(...refs.map(r => r.id))
      await new Promise(resolve => setTimeout(resolve, delayMs))
      for (const r of refs) if (fetched[r.id] !== undefined) have.set(r.id, fetched[r.id])
    },
  }
}

describe('IMDb ratings on search results', () => {
  it('adds the rating of each title the computer knows, to one decimal', async () => {
    const out = await withRatings(titles, items({ tt0113277: 8.3, tt0097493: 7 }))
    expect(out.map(t => t.imdbRating)).toEqual(['8.3', '7.0'])
  })

  it('fetches the titles it doesn’t know yet, then rates them', async () => {
    const it = items({ tt0113277: 8.3 }, { tt0097493: 7.1 })
    const out = await withRatings(titles, it)
    expect(it.asked).toEqual(['tt0097493'])
    expect(out[1].imdbRating).toBe('7.1')
  })

  it('doesn’t hold the results up for slow fetches: those come without a rating', async () => {
    const out = await withRatings(titles, items({ tt0113277: 8.3 }, { tt0097493: 7.1 }, 500), 50)
    expect(out.map(t => t.imdbRating)).toEqual(['8.3', undefined])
  })
})
