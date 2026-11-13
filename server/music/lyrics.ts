import type { LyricLine, MusicLyrics, MusicTrack } from '../../shared/music.ts'
import type { FetchJson } from './catalog.ts'
import { baseTitle, normName, splitCredit } from './catalog.ts'

// Lyrics from LRCLIB (lrclib.net): free, keyless, and most songs have them timed line by line.

const LRCLIB = 'https://lrclib.net/api'
const WEEK = 7 * 24 * 3600_000

interface LrclibEntry {
  id: number
  trackName?: string
  artistName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

/** "[01:02.34] words" lines → timed lines, in order. Tags like [ar:…] and empty timestamps are dropped. */
export function parseLrc (lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)]
    if (!stamps.length) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, '').trim()
    for (const m of stamps) {
      const t = Number(m[1]) * 60 + Number(m[2].replace(':', '.'))
      if (Number.isFinite(t)) out.push({ t: Math.round(t * 100) / 100, text })
    }
  }
  out.sort((a, b) => a.t - b.t)
  // Keep blank lines only as gaps between sung lines (they end the previous line on screen).
  return out.filter((l, i) => l.text || (i > 0 && out[i - 1].text))
}

const close = (a: number | undefined, b: number, slack: number) => !b || (typeof a === 'number' && Math.abs(a - b) <= slack)

export class Lyrics {
  private readonly get: FetchJson

  constructor (get: FetchJson) {
    this.get = get
  }

  async for (track: MusicTrack): Promise<MusicLyrics> {
    const entry = await this.find(track)
    if (!entry) return { synced: null, plain: null, instrumental: false }
    const synced = entry.syncedLyrics ? parseLrc(entry.syncedLyrics) : []
    return {
      synced: synced.length >= 3 ? synced : null,
      plain: entry.plainLyrics?.trim() || null,
      instrumental: Boolean(entry.instrumental),
    }
  }

  /** The exact match by name and length, else the closest search result that has words. */
  private async find (track: MusicTrack): Promise<LrclibEntry | null> {
    const artist = splitCredit(track.credit ?? track.artist.name)[0] ?? track.artist.name
    const title = baseTitle(track.title)
    const exact = new URLSearchParams({ artist_name: artist, track_name: title, ...(track.duration ? { duration: String(Math.round(track.duration)) } : {}) })
    const hit = await this.get<LrclibEntry>(`${LRCLIB}/get?${exact}`, { timeoutMs: 10_000, cacheMs: WEEK }).catch(() => null)
    if (hit && (hit.syncedLyrics || hit.plainLyrics || hit.instrumental)) return hit

    const list = await this.get<LrclibEntry[]>(`${LRCLIB}/search?${new URLSearchParams({ q: `${artist} ${title}` })}`, { timeoutMs: 10_000, cacheMs: WEEK }).catch(() => [])
    const want = normName(title)
    const names = splitCredit(track.credit ?? track.artist.name).map(normName)
    const candidates = (Array.isArray(list) ? list : []).filter(e =>
      normName(baseTitle(e.trackName ?? '')) === want &&
      (!names.length || splitCredit(e.artistName ?? '').some(n => names.includes(normName(n)))) &&
      close(e.duration, track.duration, 4))
    return candidates.find(e => e.syncedLyrics) ?? candidates.find(e => e.plainLyrics) ?? null
  }
}
