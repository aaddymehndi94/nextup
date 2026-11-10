import type { Episode, MediaType, TitleDetail, TitleSummary } from '../../shared/types.ts'
import { config } from '../config.ts'
import { fetchJson } from '../http.ts'

// Cinemeta is Stremio's free metadata service (IMDb-keyed, no API key). It gives us
// posters, backdrops, logos, cast and full episode lists.

interface CinemetaMeta {
  id: string
  imdb_id?: string
  type: MediaType
  name: string
  releaseInfo?: string
  year?: string
  poster?: string
  background?: string
  logo?: string
  description?: string
  runtime?: string
  genres?: string[]
  genre?: string[]
  imdbRating?: string
  cast?: string[]
  director?: string[] | null
  videos?: Array<{ id: string; season: number; episode?: number; number?: number; name?: string; title?: string; released?: string; firstAired?: string; thumbnail?: string; overview?: string; description?: string }>
}

const HOUR = 3600_000

function summary (m: CinemetaMeta): TitleSummary {
  return {
    id: m.imdb_id ?? m.id,
    type: m.type,
    name: m.name,
    year: m.releaseInfo ?? m.year,
    poster: m.poster ? largerPoster(m.poster) : undefined,
  }
}

/** metahub serves small/medium/large variants; small looks soft on modern screens. */
function largerPoster (url: string): string {
  return url.replace('/poster/small/', '/poster/medium/')
}

export async function search (query: string): Promise<TitleSummary[]> {
  const q = encodeURIComponent(query.trim())
  const [movies, series] = await Promise.allSettled([
    fetchJson<{ metas: CinemetaMeta[] }>(`${config.cinemetaUrl}/catalog/movie/top/search=${q}.json`, { cacheMs: HOUR }),
    fetchJson<{ metas: CinemetaMeta[] }>(`${config.cinemetaUrl}/catalog/series/top/search=${q}.json`, { cacheMs: HOUR }),
  ])
  if (movies.status === 'rejected' && series.status === 'rejected') throw movies.reason
  const m = movies.status === 'fulfilled' ? movies.value.metas ?? [] : []
  const s = series.status === 'fulfilled' ? series.value.metas ?? [] : []
  // Cinemeta returns each list in relevance order. Interleave so the best match of either type surfaces first.
  const out: TitleSummary[] = []
  for (let i = 0; i < Math.max(m.length, s.length); i++) {
    if (m[i]) out.push(summary(m[i]))
    if (s[i]) out.push(summary(s[i]))
  }
  return out.filter(t => t.id.startsWith('tt'))
}

export async function popular (type: MediaType): Promise<TitleSummary[]> {
  const data = await fetchJson<{ metas: CinemetaMeta[] }>(`${config.cinemetaUrl}/catalog/${type}/top.json`, { cacheMs: 6 * HOUR })
  return (data.metas ?? []).map(summary).filter(t => t.id.startsWith('tt'))
}

export async function detail (type: MediaType, id: string): Promise<TitleDetail> {
  const { meta: m } = await fetchJson<{ meta: CinemetaMeta }>(`${config.cinemetaUrl}/meta/${type}/${id}.json`, { cacheMs: 6 * HOUR })
  if (!m) throw new Error('Title not found')
  const episodes: Episode[] = (m.videos ?? [])
    .map(v => ({
      id: v.id,
      season: v.season,
      episode: v.episode ?? v.number ?? 0,
      name: v.name ?? v.title ?? `Episode ${v.episode ?? v.number}`,
      released: v.released ?? v.firstAired,
      thumbnail: v.thumbnail,
      overview: v.overview ?? v.description,
    }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
  return {
    ...summary(m),
    poster: m.poster ? largerPoster(m.poster) : undefined,
    background: m.background?.replace('/background/medium/', '/background/large/'),
    logo: m.logo,
    description: m.description,
    runtime: m.runtime,
    genres: m.genres ?? m.genre ?? [],
    imdbRating: m.imdbRating,
    cast: m.cast ?? [],
    director: m.director ?? [],
    episodes,
  }
}
