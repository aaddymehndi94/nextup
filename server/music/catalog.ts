import { createHash } from 'node:crypto'
import type { MusicAlbum, MusicAlbumRef, MusicArtist, MusicTrack } from '../../shared/music.ts'
import { fetchJson, UpstreamError } from '../http.ts'

// Where songs, artists and albums come from (docs/adr/0010):
//
// - Apple's iTunes Search API: search, an artist's songs and albums, album track lists, and full details
//   for chart songs. Official and keyless, but about 20 requests a minute, so every call waits its turn
//   (Pacer) and answers are kept for a day.
// - Deezer's public API: similar artists, artist radios and playlists (the similarity graph). From some
//   countries (India) Deezer hides songs from search, but these answers still list them.
// - Apple's chart feeds: what's most played in this country.
//
// Songs and artists get ids from their normalised names, so one song is one id whichever catalog said it.

type Json = Record<string, unknown>
export type FetchJson = <T>(url: string, opts?: { timeoutMs?: number; cacheMs?: number }) => Promise<T>

const DAY = 24 * 3600_000
const ITUNES = 'https://itunes.apple.com'
const DEEZER = 'https://api.deezer.com'

// ---- Names and ids ----------------------------------------------------------------------------------

/** Lower case, no accents or punctuation: "Beyoncé" and "BEYONCE" are one artist. */
export function normName (s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** A title without what varies between catalogs: (feat. …), (From "Film"), "- 2011 Remaster", [Official Audio]. */
export function baseTitle (title: string): string {
  return title
    .replace(/\s*[([](?:feat\.?|ft\.?|with|from)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|single version|radio edit|mono|stereo)\b.*$/i, '')
    .replace(/\s*[([](?:\d{4}\s+)?remaster(?:ed)?[^)\]]*[)\]]/gi, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .trim() || title.trim()
}

/** "Pritam, Arijit Singh & Amitabh Bhattacharya feat. X" → each name. */
export function splitCredit (credit: string): string[] {
  // " x " only in lower case between names ("Karan Aujla x Ikky"); "and" and "/" stay (Simon and Garfunkel, AC/DC).
  return credit.split(/\s+x\s+/).flatMap(part => part.split(/\s*(?:,|&|;|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\bwith\b)\s*/i))
    .map(s => s.trim()).filter(Boolean)
}

const hash = (s: string, n: number) => createHash('sha1').update(s).digest('hex').slice(0, n)
export const artistIdOf = (name: string) => `a${hash(normName(name), 12)}`
export const trackIdOf = (artist: string, title: string) => `t${hash(`${normName(splitCredit(artist)[0] ?? artist)}|${normName(baseTitle(title))}`, 16)}`

export const TRACK_ID = /^t[0-9a-f]{16}$/
export const ARTIST_ID = /^a[0-9a-f]{12}$/
export const ALBUM_ID = /^(it|dz)\d{1,15}$/

/** Where an artist lives in each catalog, learned as answers come in. */
export interface ArtistRef { id: string; name: string; picture?: string; itunes?: string; deezer?: string }
export interface ArtistBook {
  get (id: string): ArtistRef | null
  put (ref: ArtistRef): void
}

// ---- Pacing -------------------------------------------------------------------------------------------

/** At most `perMinute` calls in any 60 s; a call someone is waiting for goes before background work. */
export class Pacer {
  private readonly perMinute: number
  private readonly now: () => number
  private readonly calls: number[] = []
  private readonly queue: Array<{ urgent: boolean; go: () => void }> = []
  private timer: NodeJS.Timeout | null = null

  constructor (perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute
    this.now = now
  }

  /** Waits for a turn. `urgent` (someone is looking at the screen) skips ahead of background work. */
  turn (urgent: boolean): Promise<void> {
    return new Promise(resolve => {
      const entry = { urgent, go: resolve }
      if (urgent) {
        const i = this.queue.findIndex(q => !q.urgent)
        this.queue.splice(i < 0 ? this.queue.length : i, 0, entry)
      } else this.queue.push(entry)
      this.pump()
    })
  }

  /** How long the next call would wait, in ms (0 if now). */
  get waitMs (): number {
    this.prune()
    return this.calls.length < this.perMinute ? 0 : this.calls[0] + 60_000 - this.now()
  }

  private prune () {
    const cutoff = this.now() - 60_000
    while (this.calls.length && this.calls[0] <= cutoff) this.calls.shift()
  }

  private pump () {
    if (this.timer) return
    while (this.queue.length) {
      const wait = this.waitMs
      if (wait > 0) {
        this.timer = setTimeout(() => { this.timer = null; this.pump() }, wait + 50)
        this.timer.unref?.()
        return
      }
      this.calls.push(this.now())
      this.queue.shift()!.go()
    }
  }
}

// ---- Shapes -------------------------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const year = (v: unknown) => { const y = Number.parseInt(str(v).slice(0, 4), 10); return y > 1900 ? y : undefined }
const dzCover = (md5: string, px = 500) => (md5 ? `https://cdn-images.dzcdn.net/images/cover/${md5}/${px}x${px}-000000-80-0-0.jpg` : undefined)
const itArt = (url: string, px = 600) => (url ? url.replace(/\/\d+x\d+bb\./, `/${px}x${px}bb.`) : undefined)

/** An iTunes song result as a track. Undefined for anything that isn't a playable song. */
export function fromItunes (r: Json, rank?: number): (MusicTrack & { itunesArtist: string }) | undefined {
  if (r.wrapperType !== 'track' || (r.kind && r.kind !== 'song')) return undefined
  const title = str(r.trackName)
  const credit = str(r.artistName)
  if (!title || !credit) return undefined
  const first = splitCredit(credit)[0] ?? credit
  // iTunes credits the album artist's id; the first name in the credit is usually the same person.
  return {
    id: trackIdOf(credit, title),
    title,
    artist: { id: artistIdOf(first), name: first },
    credit: credit !== first ? credit : undefined,
    album: r.collectionId ? { id: `it${num(r.collectionId)}`, title: str(r.collectionName), cover: itArt(str(r.artworkUrl100)) } : undefined,
    duration: Math.round(num(r.trackTimeMillis) / 1000),
    explicit: r.trackExplicitness === 'explicit' || undefined,
    rank,
    itunesArtist: str(r.artistId),
  }
}

/** A Deezer track as a track, with the Deezer artist (for pictures and radios). */
export function fromDeezer (r: Json): (MusicTrack & { deezerArtist: ArtistRef }) | undefined {
  const a = (r.artist ?? {}) as Json
  const al = (r.album ?? {}) as Json
  const title = str(r.title)
  const name = str(a.name)
  if (!title || !name) return undefined
  const contributors = Array.isArray(r.contributors) ? (r.contributors as Json[]).map(c => str(c.name)).filter(Boolean) : []
  // Deezer lists some duets as their own artist ("Arijit Singh & Antara Mitra"): the first name is the artist.
  const names = splitCredit(name)
  const first = names[0] ?? name
  const credit = contributors.length > 1 ? contributors.join(', ') : names.length > 1 ? name : undefined
  const picture = names.length > 1 ? undefined : dzPicture(a)
  return {
    id: trackIdOf(name, title),
    title,
    artist: { id: artistIdOf(first), name: first, ...(picture ? { picture } : {}) },
    ...(credit ? { credit } : {}),
    album: al.id ? { id: `dz${num(al.id)}`, title: str(al.title), cover: str(al.cover_big) || dzCover(str(al.md5_image) || str(r.md5_image)) } : undefined,
    duration: num(r.duration),
    explicit: r.explicit_lyrics === true || undefined,
    rank: Math.min(1, num(r.rank) / 1_000_000) || undefined,
    deezerArtist: names.length > 1 ? { id: artistIdOf(first), name: first } : { id: artistIdOf(name), name, picture, deezer: str(a.id) },
  }
}

/** Deezer's picture, unless it's the blank placeholder (an empty image hash in the URL). */
const dzPicture = (a: Json) => [str(a.picture_big), str(a.picture_medium)].find(u => u && !u.includes('/artist//'))

const fromDeezerArtist = (a: Json): ArtistRef & { fans: number } => {
  const name = str(a.name)
  return { id: artistIdOf(name), name, picture: dzPicture(a), deezer: str(a.id), fans: num(a.nb_fan) }
}

/** One per name: Deezer often has several artists with one name; the one with most fans is the real one. */
function bestByName (list: Json[]): Array<ArtistRef & { fans: number }> {
  const by = new Map<string, ArtistRef & { fans: number }>()
  for (const a of list.map(fromDeezerArtist)) {
    if (splitCredit(a.name).length > 1) continue
    const have = by.get(a.id)
    if (!have || a.fans > have.fans) by.set(a.id, a)
  }
  return [...by.values()]
}

// ---- The catalog ----------------------------------------------------------------------------------------

export interface CatalogOptions {
  artists: ArtistBook
  /** Two-letter store country: "in". */
  country: string
  fetch?: FetchJson
  /** iTunes calls a minute (Apple asks for about 20). */
  itunesPerMinute?: number
}

export class Catalog {
  readonly country: string
  private readonly artists: ArtistBook
  private readonly get: FetchJson
  private readonly itunes: Pacer
  private readonly itunesAnswers = new Map<string, { at: number; value: Promise<Json> }>()
  /** Artists whose Deezer id was picked by name and fans (not just seen on a song) since this started. */
  private readonly sure = new Set<string>()

  constructor (opts: CatalogOptions) {
    this.artists = opts.artists
    this.country = opts.country
    this.get = opts.fetch ?? fetchJson
    this.itunes = new Pacer(opts.itunesPerMinute ?? 18)
  }

  /** Seconds before an iTunes call would go out now (search falls back sooner than that). */
  get itunesWaitMs (): number { return this.itunes.waitMs }

  // -- iTunes --

  private itunesCall (path: string, params: Record<string, string>, urgent: boolean, ttl = DAY): Promise<Json> {
    const url = `${ITUNES}/${path}?${new URLSearchParams({ country: this.country, ...params })}`
    const hit = this.itunesAnswers.get(url)
    if (hit && Date.now() - hit.at < ttl) return hit.value
    const value = this.itunes.turn(urgent).then(() => this.get<Json>(url, { timeoutMs: 15_000 }))
    this.itunesAnswers.set(url, { at: Date.now(), value })
    value.catch(() => this.itunesAnswers.delete(url))
    if (this.itunesAnswers.size > 800) this.itunesAnswers.delete(this.itunesAnswers.keys().next().value!)
    return value
  }

  private noteItunesArtist (t: { artist: MusicArtist; itunesArtist: string; credit?: string }) {
    // Only when the credit is one name: then the album artist id is surely this artist.
    if (!t.itunesArtist || t.credit) return
    const known = this.artists.get(t.artist.id)
    if (known?.itunes) return
    this.artists.put({ ...(known ?? { id: t.artist.id, name: t.artist.name }), itunes: t.itunesArtist })
  }

  private songs (results: unknown, opts: { rankByOrder?: boolean } = {}): MusicTrack[] {
    const list = Array.isArray(results) ? results as Json[] : []
    const out: MusicTrack[] = []
    const seen = new Set<string>()
    for (const r of list) {
      const t = fromItunes(r, opts.rankByOrder ? Math.max(0.05, 1 - out.length / 60) : undefined)
      if (!t || seen.has(t.id)) continue
      seen.add(t.id)
      this.noteItunesArtist(t)
      const { itunesArtist: _, ...track } = t
      out.push(track)
    }
    return out
  }

  /** Songs matching words, most relevant first. */
  async searchSongs (q: string, limit = 30): Promise<MusicTrack[]> {
    const r = await this.itunesCall('search', { term: q, media: 'music', entity: 'song', limit: String(limit) }, true, 3600_000)
    return this.songs(r.results)
  }

  /** Artists matching words (Deezer: it has their pictures, and doesn't hide artists). */
  async searchArtists (q: string, limit = 8): Promise<MusicArtist[]> {
    const r = await this.deezer<{ data?: Json[] }>(`/search/artist?${new URLSearchParams({ q, limit: String(limit) })}`, 3600_000)
    return bestByName(r.data ?? []).map(a => { this.sure.add(a.id); return this.remember(a, true) }).map(({ id, name, picture }) => ({ id, name, ...(picture ? { picture } : {}) }))
  }

  /** One song by artist and title, for a model's suggestion: the closest match iTunes has. */
  async findSong (artist: string, title: string, urgent = false): Promise<MusicTrack | null> {
    const r = await this.itunesCall('search', { term: `${artist} ${baseTitle(title)}`, media: 'music', entity: 'song', limit: '8' }, urgent, 7 * DAY)
    const want = normName(baseTitle(title))
    const names = splitCredit(artist).map(normName)
    const songs = this.songs(r.results)
    return songs.find(s => normName(baseTitle(s.title)) === want && splitCredit(s.credit ?? s.artist.name).some(n => names.includes(normName(n))))
      ?? songs.find(s => normName(baseTitle(s.title)) === want)
      ?? null
  }

  /** Full details for chart songs, many in one call. */
  async songsById (itunesIds: string[]): Promise<MusicTrack[]> {
    if (!itunesIds.length) return []
    const r = await this.itunesCall('lookup', { id: itunesIds.slice(0, 150).join(','), entity: 'song' }, false)
    const tracks = this.songs(r.results)
    return tracks
  }

  /** The artist's iTunes id: known already, or found by name. */
  private async itunesArtist (a: ArtistRef, urgent: boolean): Promise<string | null> {
    if (a.itunes) return a.itunes
    const r = await this.itunesCall('search', { term: a.name, media: 'music', entity: 'musicArtist', limit: '5' }, urgent, 7 * DAY)
    const want = normName(a.name)
    const hit = (Array.isArray(r.results) ? r.results as Json[] : []).find(x => normName(str(x.artistName)) === want)
    if (!hit) return null
    const id = str(hit.artistId)
    this.artists.put({ ...a, itunes: id })
    return id
  }

  /** An artist's best-known songs and their albums. */
  async artistPage (a: ArtistRef, urgent = true): Promise<{ top: MusicTrack[]; albums: Array<MusicAlbumRef & { year?: number; kind?: string }> }> {
    const id = await this.itunesArtist(a, urgent)
    if (!id) return { top: [], albums: [] }
    const [songs, albums] = await Promise.all([
      this.itunesCall('lookup', { id, entity: 'song', limit: '60' }, urgent),
      this.itunesCall('lookup', { id, entity: 'album', limit: '60' }, urgent),
    ])
    const top = this.songs(songs.results, { rankByOrder: true })
    const seen = new Set<string>()
    const list = (Array.isArray(albums.results) ? albums.results as Json[] : [])
      .filter(x => x.wrapperType === 'collection' && str(x.collectionName))
      .map(x => ({
        id: `it${num(x.collectionId)}`,
        title: str(x.collectionName),
        cover: itArt(str(x.artworkUrl100)),
        year: year(x.releaseDate),
        kind: num(x.trackCount) <= 3 ? 'Single' : num(x.trackCount) <= 6 ? 'EP' : 'Album',
      }))
      .filter(x => { const k = normName(x.title); if (seen.has(k)) return false; seen.add(k); return true })
      .sort((x, y) => (y.year ?? 0) - (x.year ?? 0))
    return { top, albums: list }
  }

  /** An album and its songs (Apple's; for a Deezer album, Apple's copy found by name). */
  async album (id: string, urgent = true): Promise<MusicAlbum | null> {
    let itunesId = id.startsWith('it') ? id.slice(2) : null
    if (!itunesId) {
      const dz = await this.deezer<Json>(`/album/${id.slice(2)}`, DAY).catch(() => null)
      if (!dz?.title) return null
      const r = await this.itunesCall('search', { term: `${str((dz.artist as Json)?.name)} ${str(dz.title)}`, media: 'music', entity: 'album', limit: '5' }, urgent, 7 * DAY)
      const want = normName(baseTitle(str(dz.title)))
      const hit = (Array.isArray(r.results) ? r.results as Json[] : []).find(x => normName(baseTitle(str(x.collectionName))) === want)
      if (!hit) return null
      itunesId = str(hit.collectionId)
    }
    const r = await this.itunesCall('lookup', { id: itunesId, entity: 'song' }, urgent)
    const list = Array.isArray(r.results) ? r.results as Json[] : []
    const head = list.find(x => x.wrapperType === 'collection')
    if (!head) return null
    const credit = str(head.artistName)
    const artist = { id: artistIdOf(credit), name: credit }
    return {
      id: `it${itunesId}`,
      title: str(head.collectionName),
      cover: itArt(str(head.artworkUrl100)),
      artist,
      year: year(head.releaseDate),
      tracks: this.songs(list),
    }
  }

  // -- Deezer: the similarity graph --

  private async deezer<T> (path: string, cacheMs: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.get<T & { error?: { code?: number; message?: string } }>(`${DEEZER}${path}`, { timeoutMs: 12_000, cacheMs })
      // Deezer answers 200 with { error } when it's busy (code 4: more than 50 calls in 5 s).
      if (!r?.error) return r
      if (r.error.code === 4 && attempt < 2) { await new Promise(res => setTimeout(res, 1200)); continue }
      throw new UpstreamError(`Deezer: ${r.error.message ?? 'error'}`)
    }
  }

  /** Notes where an artist is. `sure`: this Deezer id was picked by fans among same-named artists. */
  private remember (ref: ArtistRef & { fans?: number }, sure = false): ArtistRef {
    const known = this.artists.get(ref.id)
    const { fans: _, ...plain } = ref
    const deezer = sure || !known?.deezer ? plain.deezer : known.deezer
    const picture = sure || !known?.picture ? plain.picture ?? known?.picture : known.picture
    const merged = { ...known, ...plain, deezer, picture, itunes: known?.itunes ?? plain.itunes }
    if (!known || known.deezer !== merged.deezer || known.picture !== merged.picture) this.artists.put(merged)
    return merged
  }

  /** The artist's Deezer id: known already, or found by name. */
  async deezerArtist (a: { id: string; name: string }): Promise<ArtistRef | null> {
    const known = this.artists.get(a.id)
    if (known?.deezer && this.sure.has(a.id)) return known
    const r = await this.deezer<{ data?: Json[] }>(`/search/artist?${new URLSearchParams({ q: a.name, limit: '10' })}`, 7 * DAY)
    const hit = bestByName(r.data ?? []).find(x => x.id === a.id)
    if (!hit) return known?.deezer ? known : null
    this.sure.add(a.id)
    return this.remember(hit, true)
  }

  private deezerTracks (data: Json[] | undefined): MusicTrack[] {
    const out: MusicTrack[] = []
    const seen = new Set<string>()
    for (const r of data ?? []) {
      const t = fromDeezer(r)
      if (!t || seen.has(t.id)) continue
      seen.add(t.id)
      this.remember(t.deezerArtist)
      const { deezerArtist: _, ...track } = t
      out.push(track)
    }
    return out
  }

  /** Artists like this one, closest first. */
  async related (a: { id: string; name: string }, limit = 20): Promise<MusicArtist[]> {
    const dz = await this.deezerArtist(a)
    if (!dz?.deezer) return []
    const r = await this.deezer<{ data?: Json[] }>(`/artist/${dz.deezer}/related?limit=${limit}`, DAY)
    return bestByName(r.data ?? []).map(x => this.remember(x)).map(({ id, name, picture }) => ({ id, name, ...(picture ? { picture } : {}) }))
  }

  /** Deezer's radio for an artist: their songs and songs by artists like them. */
  async artistRadio (a: { id: string; name: string }, limit = 40): Promise<MusicTrack[]> {
    const dz = await this.deezerArtist(a)
    if (!dz?.deezer) return []
    const r = await this.deezer<{ data?: Json[] }>(`/artist/${dz.deezer}/radio?limit=${limit}`, 6 * 3600_000)
    return this.deezerTracks(r.data)
  }

  /** Songs from the best playlists for some words ("rainy evening", "punjabi workout"), with their names. */
  async playlistTracks (q: string, playlists = 3, perList = 60): Promise<Array<{ name: string; tracks: MusicTrack[] }>> {
    const r = await this.deezer<{ data?: Json[] }>(`/search/playlist?${new URLSearchParams({ q, limit: '12' })}`, DAY)
    const lists = (r.data ?? []).filter(p => num(p.nb_tracks) >= 15).slice(0, playlists)
    const out = await Promise.all(lists.map(async p => {
      const t = await this.deezer<{ data?: Json[] }>(`/playlist/${num(p.id)}/tracks?limit=${perList}`, DAY).catch(() => ({ data: [] as Json[] }))
      return { name: str(p.title), tracks: this.deezerTracks(t.data) }
    }))
    return out.filter(x => x.tracks.length)
  }

  // -- Charts --

  /** What's most played in this country now (Apple's chart, with full details from iTunes). */
  async chart (limit = 50): Promise<MusicTrack[]> {
    limit = limit <= 10 ? 10 : limit <= 25 ? 25 : limit <= 50 ? 50 : 100
    const feed = await this.get<{ feed?: { results?: Json[] } }>(`https://rss.applemarketingtools.com/api/v2/${this.country}/music/most-played/${limit}/songs.json`, { timeoutMs: 15_000, cacheMs: 6 * 3600_000 })
    const ids = (feed.feed?.results ?? []).map(r => str(r.id)).filter(id => /^\d+$/.test(id))
    const songs = await this.songsById(ids)
    // lookup doesn't keep the order; the feed's order is the chart.
    const byTitle = new Map((feed.feed?.results ?? []).map((r, i) => [trackIdOf(str(r.artistName), str(r.name)), i]))
    return songs
      .map(s => ({ s, i: byTitle.get(s.id) ?? 999 }))
      .sort((x, y) => x.i - y.i)
      .map(({ s }, i) => ({ ...s, rank: Math.max(0.3, 1 - i / 100) }))
  }
}

/** The store country for this computer: NEXTTUPP_MUSIC_COUNTRY, else from its time zone, else its locale. */
export function storeCountry (env = process.env.NEXTTUPP_MUSIC_COUNTRY): string {
  if (env && /^[a-z]{2}$/i.test(env)) return env.toLowerCase()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  const byZone: Record<string, string> = {
    'Asia/Kolkata': 'in', 'Asia/Calcutta': 'in', 'Europe/London': 'gb', 'Asia/Karachi': 'pk', 'Asia/Dhaka': 'bd',
    'Asia/Dubai': 'ae', 'Asia/Singapore': 'sg', 'Australia/Sydney': 'au', 'Australia/Melbourne': 'au', 'Asia/Tokyo': 'jp',
  }
  if (byZone[zone]) return byZone[zone]
  try {
    const region = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).maximize().region
    if (region && /^[A-Z]{2}$/.test(region)) return region.toLowerCase()
  } catch { /* old ICU */ }
  return 'us'
}
