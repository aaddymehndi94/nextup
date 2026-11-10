import type { MediaType, Source } from '../../shared/types.ts'
import { config } from '../config.ts'
import { fetchJson } from '../http.ts'
import { parseRelease, parseTorrentioStream, type TorrentioStream } from './release.ts'

type Candidate = Omit<Source, 'score' | 'notes'>

/** What we're looking for: a movie, or one episode of a series. */
export interface SourceQuery {
  type: MediaType
  imdbId: string
  season?: number
  episode?: number
  /** Human title, used by providers that search by name. */
  name: string
  year?: string
}

export interface Provider {
  name: string
  find(q: SourceQuery): Promise<Candidate[]>
}

const MIN = 60_000

export const torrentio: Provider = {
  name: 'Torrentio',
  async find (q) {
    const id = q.type === 'series' ? `${q.imdbId}:${q.season}:${q.episode}` : q.imdbId
    const data = await fetchJson<{ streams?: TorrentioStream[] }>(`${config.torrentioUrl}/stream/${q.type}/${id}.json`, { timeoutMs: 20_000, cacheMs: 20 * MIN })
    return (data.streams ?? []).map(parseTorrentioStream).filter((s): s is Candidate => s !== null)
  },
}

interface ApibayItem { name: string; info_hash: string; seeders: string; leechers: string; size: string; num_files: string; imdb?: string; category?: string }

const pad = (n: number) => String(n).padStart(2, '0')

export const apibay: Provider = {
  name: 'ThePirateBay',
  async find (q) {
    // apibay supports searching by IMDb id for movies. Episodes need a name search plus filtering.
    const term = q.type === 'movie' ? q.imdbId : `${q.name} S${pad(q.season!)}E${pad(q.episode!)}`
    const items = await fetchJson<ApibayItem[]>(`https://apibay.org/q.php?q=${encodeURIComponent(term)}`, { timeoutMs: 12_000, cacheMs: 20 * MIN })
    const epTag = q.type === 'series' ? new RegExp(`S0?${q.season}E0?${q.episode}(?!\\d)`, 'i') : null
    return items
      .filter(i => i.info_hash && !/^0+$/.test(i.info_hash) && i.name !== 'No results returned')
      .filter(i => !epTag || epTag.test(i.name))
      // apibay can't tell us which file inside a multi-file torrent is the episode; skip packs for series.
      .filter(i => q.type === 'movie' || Number(i.num_files) <= 3)
      .map(i => ({
        infoHash: i.info_hash.toLowerCase(),
        title: i.name,
        sizeBytes: Number(i.size) || undefined,
        seeders: Number(i.seeders),
        leechers: Number(i.leechers),
        providers: ['ThePirateBay'],
        languages: [],
        trackers: [],
        release: parseRelease(i.name),
      }))
  },
}

export const PROVIDERS: Provider[] = [torrentio, apibay]
