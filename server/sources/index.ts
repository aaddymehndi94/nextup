import type { SourcesResponse } from '../../shared/types.ts'
import { config } from '../config.ts'
import { PROVIDERS, type SourceQuery } from './providers.ts'
import { rankSources } from './rank.ts'

export type { SourceQuery }

/** Queries every provider in parallel; one slow or broken provider never blocks the others. */
export async function findSources (q: SourceQuery, runtimeMin?: number): Promise<SourcesResponse> {
  const errors: Record<string, string> = {}
  const settled = await Promise.allSettled(PROVIDERS.map(p => p.find(q)))
  const all = settled.flatMap((r, i) => {
    if (r.status === 'fulfilled') return r.value
    errors[PROVIDERS[i].name] = (r.reason as Error).message
    return []
  })
  const sources = rankSources(all, { preferredLanguages: config.preferredLanguages, runtimeMin })
  return { sources, errors }
}
