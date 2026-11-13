import { createHash } from 'node:crypto'
import type { Profile } from '../../shared/types.ts'
import type {
  MixKind, MusicAlbum, MusicArtist, MusicArtistPage, MusicHome, MusicLyrics, MusicMix, MusicMixCard, MusicRadioRequest, MusicRadioResponse,
  MusicSearchResponse, MusicSetup, MusicTrack,
} from '../../shared/music.ts'
import { HttpError } from '../http.ts'
import type { Ask } from '../ai/providers.ts'
import { artistIdOf, baseTitle, type Catalog, type FetchJson, normName, splitCredit, trackIdOf } from './catalog.ts'
import { arrange, buildTaste, byPosition, type Candidate, featuring, merge, score, type ScoreOptions, seedArtists, type Taste } from './engine.ts'
import type { MusicFiles } from './files.ts'
import type { Lyrics } from './lyrics.ts'
import type { SavedMix, MusicStore } from './store.ts'

// Music for one computer and its profiles: home, search, pages, radios, mixes (the engine's, and a model's
// when someone asks), likes and listens. See docs/adr/0010.

const DAY = 24 * 3600_000
const MIX_TTL_MS = 12 * 3600_000
const ENGINE_KINDS: MixKind[] = ['daily', 'artist', 'discover', 'repeat']

export interface MusicAi {
  musicAvailability (): { available: boolean; hint?: string }
  askMusic (q: Ask): Promise<{ text: string; model: { name: string } }>
}

export interface MusicDeps {
  catalog: Catalog
  store: MusicStore
  files: MusicFiles
  lyrics: Lyrics
  ai: MusicAi | null
  /** For LRCLIB searches when checking a model's suggestions. */
  fetch: FetchJson
  log?: (msg: string) => void
  now?: () => number
}

const mixId = (profileId: string, kind: string, key = '') => `m${createHash('sha1').update(`${profileId}|${kind}|${key}`).digest('hex').slice(0, 15)}`

const MUSIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'tracks'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['artist', 'title', 'why'],
        properties: { artist: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' } },
      },
    },
  },
} as const

export const MUSIC_SYSTEM = `You are the music recommendation engine of nexttupp, a personal music player. You get one listener's likes, what they play and skip, and sometimes a request, and you make one mix for them.

How to choose:
- Work out what they respond to: sound, mood, energy, era, scene, language, the singers and composers behind the songs. Not just genres. Skips and dislikes count as much as likes.
- About a quarter can be songs they already love or play; the rest should be songs they'll love but probably haven't heard: deeper cuts from artists they like and artists close to them. At most two songs per artist.
- If they listen in more than one language, keep that balance unless the request says otherwise.
- Follow the request closely when there is one (a mood, an activity, an era, a language).
- Order the songs so the mix flows: open strong, vary the energy, no jarring jumps.
- Only real, released songs, by the artist who released them, in the original studio version (no covers, live, remixes, slowed or lofi versions unless asked). Leave out anything you are unsure exists.
- title: the song's name as it was released, without "(feat. …)". artist: the main artist as credited (for film songs, the singer).
- why: at most 10 words, written to the listener, on why it's here. Don't repeat the song or artist name.
- The mix's title: at most 4 words, evocative, no emoji. description: at most 14 words.
Make 25 songs.`

export class MusicService {
  private readonly d: MusicDeps
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private readonly building = new Map<string, Promise<void>>()
  private enriching = false
  private readonly enrichQueue: MusicTrack[] = []
  private startersCache: { at: number; list: MusicArtist[] } | null = null

  constructor (deps: MusicDeps) {
    this.d = deps
    this.log = deps.log ?? (() => {})
    this.now = deps.now ?? Date.now
  }

  // ---- Setup ----

  setup (local: boolean): MusicSetup {
    const s = this.d.files.source.status()
    return {
      ready: s.helper === 'ok',
      source: this.d.files.source.kind,
      helper: s.helper,
      ...(s.message ? { message: s.message } : {}),
      ...(s.progress !== undefined ? { progress: s.progress } : {}),
      canInstall: local && Boolean(this.d.files.source.install) && (s.helper === 'missing' || s.helper === 'error'),
    }
  }

  /**
   * Starts "Set up music" and answers at once: the download can take minutes on a slow line, so the page
   * follows it with setup() (the source keeps the progress, and any problem, until the next try).
   */
  install (): MusicSetup {
    const src = this.d.files.source
    if (!src.install) throw new HttpError(409, 'Nothing to set up.')
    if (src.status().helper !== 'ok') src.install().catch(err => this.log(`music: setup failed (${(err as Error).message})`))
    return this.setup(true)
  }

  // ---- Taste ----

  private taste (profile: Profile): Taste {
    const s = this.d.store
    return buildTaste(s.history(profile.id, this.now() - 365 * DAY), s.ratings(profile.id), s.liked(profile.id), id => s.artist(id)?.name, this.now())
  }

  private remember<T extends MusicTrack[]> (tracks: T): T {
    this.d.store.saveTracks(tracks)
    return tracks
  }

  private scoreAll (taste: Taste, cands: Candidate[], o: ScoreOptions) {
    return cands.map(c => ({ ...c, score: score(taste, c, o) }))
  }

  private dayNumber (): number { return Math.floor(this.now() / DAY) }

  // ---- Home ----

  async home (profile: Profile, opts: { local: boolean; refresh?: boolean }): Promise<MusicHome> {
    const s = this.d.store
    const taste = this.taste(profile)
    const [trending] = await Promise.all([
      this.d.catalog.chart(40).then(t => this.remember(t)).catch(err => { this.log(`music: chart unavailable (${(err as Error).message})`); return [] as MusicTrack[] }),
      taste.hasSignal ? this.ensureMixes(profile, taste, Boolean(opts.refresh)) : Promise.resolve(),
    ])
    const mixes = s.mixes(profile.id)
    const engine = mixes.filter(m => ENGINE_KINDS.includes(m.kind))
    const asked = mixes.filter(m => m.kind === 'ai' || m.kind === 'mood').slice(0, 6)
    const order: MixKind[] = ['daily', 'artist', 'discover', 'repeat']
    engine.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    const cards = [...asked.slice(0, 1), ...engine, ...asked.slice(1)].map(m => this.card(m)).filter(c => c.count > 0)
    const artists = seedArtists(taste, 14).map(a => s.artist(a.id) ?? { id: a.id, name: a.name })
    return {
      setup: this.setup(opts.local),
      needsSeeds: !taste.hasSignal,
      mixes: cards,
      recent: s.recent(profile.id, 16),
      liked: s.liked(profile.id, 16),
      likedCount: s.likedCount(profile.id),
      artists,
      trending,
      ai: this.d.ai?.musicAvailability() ?? { available: false },
    }
  }

  private card (m: SavedMix): MusicMixCard {
    const tracks = this.d.store.tracks(m.tracks.slice(0, 12).map(t => t.id))
    const covers: string[] = []
    for (const t of tracks) {
      const c = t.album?.cover ?? t.artist.picture
      if (c && !covers.includes(c)) covers.push(c)
      if (covers.length === 4) break
    }
    return { id: m.id, kind: m.kind, title: m.title, subtitle: m.subtitle, covers, count: m.tracks.length, ...(m.model ? { model: m.model } : {}), at: m.at }
  }

  /** The engine's mixes, made again when they're half a day old or a lot has been played since. */
  private ensureMixes (profile: Profile, taste: Taste, force: boolean): Promise<void> {
    const mixes = this.d.store.mixes(profile.id).filter(m => ENGINE_KINDS.includes(m.kind))
    const newest = mixes.reduce((t, m) => Math.max(t, m.at), 0)
    const playedSince = newest ? this.d.store.history(profile.id, newest).length : 0
    const stale = !mixes.length || this.now() - newest > MIX_TTL_MS || playedSince >= 25 || force
    if (!stale) return Promise.resolve()
    let p = this.building.get(profile.id)
    if (!p) {
      p = this.buildMixes(profile, taste).catch(err => this.log(`music: mixes failed: ${(err as Error).message}`)).finally(() => this.building.delete(profile.id))
      this.building.set(profile.id, p)
    }
    // A first visit waits for them; later ones show the old mixes if this takes long.
    return mixes.length ? Promise.race([p, new Promise<void>(resolve => setTimeout(resolve, 6000).unref())]) : p
  }

  private async buildMixes (profile: Profile, taste: Taste): Promise<void> {
    const c = this.d.catalog
    const s = this.d.store
    const at = this.now()
    const day = this.dayNumber()
    const seeds = seedArtists(taste, 5)
    const radios = await Promise.all(seeds.map(a => c.artistRadio(a).then(t => this.remember(t)).catch(() => [] as MusicTrack[])))
    const made: SavedMix[] = []
    const save = (kind: MixKind, key: string, title: string, subtitle: string, list: Candidate[]) => {
      if (list.length < 5) return
      made.push({ id: mixId(profile.id, kind, key), kind, title, subtitle, tracks: list.map(x => ({ id: x.track.id, why: x.why })), at })
    }

    // Your daily mix: songs they love, more from their artists, and artists close to them.
    const liked = s.liked(profile.id, 200)
    const history = s.history(profile.id, at - 90 * DAY)
    const plays = new Map<string, number>()
    for (const l of history) if (l.outcome === 'complete') plays.set(l.trackId, (plays.get(l.trackId) ?? 0) + 1)
    const favourites = s.tracks([...plays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id]) => id))
    const familiar = [
      ...byPosition(liked.slice(0, 60), () => 'A song you love', 0.3).map(x => ({ ...x, fit: x.fit * 0.6 })),
      ...byPosition(favourites, () => 'On repeat lately', 0.3).map(x => ({ ...x, fit: x.fit * 0.5 })),
    ]
    const fromRadios = radios.flatMap((r, i) => byPosition(r, t => t.artist.id === seeds[i].id ? `More ${seeds[i].name}` : `Because you like ${seeds[i].name}`))
    const daily = arrange(this.scoreAll(taste, merge([familiar, fromRadios]), { now: at, tasteWeight: 0.6, seed: day }), { size: 40, perArtist: 3, gap: 3 })
    save('daily', '', 'Your daily mix', `${featuring(daily.map(x => x.track))} and more`, daily)

    // A mix around each of their top three artists.
    seeds.slice(0, 3).forEach((a, i) => {
      const list = arrange(this.scoreAll(taste, byPosition(radios[i], t => t.artist.id === a.id ? `${a.name}` : `Sounds like ${a.name}`), { now: at, tasteWeight: 0.3, seed: day }), { size: 30, perArtist: 5, gap: 1 })
      const others = featuring(list.map(x => x.track), [a.id], 2)
      save('artist', a.id, `${a.name} mix`, others ? `With ${others}` : `${a.name} and artists like them`, list)
    })

    // Discover: artists they haven't heard, close to the ones they love.
    const related = await Promise.all(seeds.slice(0, 3).map(a => c.related(a, 10).catch(() => [] as MusicArtist[])))
    const fresh = related.map(list => list.find(r => !taste.artists.has(r.id))).filter((a): a is MusicArtist => Boolean(a))
    const freshRadios = await Promise.all(fresh.map(a => c.artistRadio(a, 25).then(t => this.remember(t)).catch(() => [] as MusicTrack[])))
    const unheard = (t: MusicTrack) => !taste.artists.has(t.artist.id)
    const discoverPool = [
      ...radios.flatMap((r, i) => byPosition(r.filter(unheard), () => `New to you, like ${seeds[i].name}`)),
      ...freshRadios.flatMap((r, i) => byPosition(r.filter(unheard), () => `New to you, close to ${seeds[related.findIndex(l => l.includes(fresh[i]))]?.name ?? 'what you play'}`)),
    ]
    const discover = arrange(this.scoreAll(taste, merge([discoverPool]), { now: at, tasteWeight: 0.2, familiarity: -1, seed: day }), { size: 30, perArtist: 2, gap: 4 })
    save('discover', '', 'Discover', 'Artists new to you, close to what you play', discover)

    // On repeat: what they've finished most this month.
    const month = new Map<string, number>()
    for (const l of history) if (l.outcome === 'complete' && at - l.at < 30 * DAY) month.set(l.trackId, (month.get(l.trackId) ?? 0) + 1)
    const repeat = [...month.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30)
    const repeatTracks = s.tracks(repeat.map(([id]) => id))
    save('repeat', '', 'On repeat', 'The songs you can’t stop playing', repeatTracks.map(t => ({ track: t, fit: 1, why: `Played ${month.get(t.id)} times this month` })))

    s.dropMixes(profile.id, ENGINE_KINDS)
    for (const m of made) s.saveMix(profile.id, m)
    this.log(`music: made ${made.length} mixes`)
  }

  // ---- Mixes ----

  mix (profile: Profile, id: string): MusicMix {
    if (id === 'liked') {
      const tracks = this.d.store.liked(profile.id)
      return { id, kind: 'liked', title: 'Liked songs', subtitle: `${tracks.length} song${tracks.length === 1 ? '' : 's'}`, covers: [], tracks, at: this.now() }
    }
    const m = this.d.store.mix(profile.id, id)
    if (!m) throw new HttpError(404, 'That mix is gone. Music home has new ones.')
    const why = new Map(m.tracks.map(t => [t.id, t.why]))
    const tracks = this.d.store.tracks(m.tracks.map(t => t.id)).map(t => ({ ...t, ...(why.get(t.id) ? { why: why.get(t.id) } : {}) }))
    return { ...this.card(m), tracks }
  }

  // ---- Radio (start from a song, an artist, some words, or their taste) ----

  /** `keep: false` (private mode) plays a mood mix without saving it. */
  async radio (profile: Profile, req: MusicRadioRequest, opts: { keep?: boolean } = {}): Promise<MusicRadioResponse> {
    const taste = this.taste(profile)
    const exclude = new Set(req.exclude ?? [])
    const at = this.now()
    if (req.mood) return this.moodMix(profile, taste, req.mood, exclude, opts.keep !== false)

    const seedTrack = req.track ? this.d.store.track(req.track) : null
    const seedArtist = seedTrack?.artist ?? (req.artist ? this.d.store.artist(req.artist) : null)
    if (!seedArtist) {
      // "Keep playing" after a mix: more of the daily mix's kind of thing.
      const seeds = seedArtists(taste, 4)
      if (!seeds.length) return { title: 'Popular now', tracks: (await this.d.catalog.chart(40).catch(() => [])).filter(t => !exclude.has(t.id)) }
      const radios = await Promise.all(seeds.map(a => this.d.catalog.artistRadio(a).then(t => this.remember(t)).catch(() => [] as MusicTrack[])))
      const pool = merge(radios.map((r, i) => byPosition(r, t => (t.artist.id === seeds[i].id ? `More ${seeds[i].name}` : `Because you like ${seeds[i].name}`))))
      const list = arrange(this.scoreAll(taste, pool, { now: at, tasteWeight: 0.6, exclude, seed: at }), { size: 30, perArtist: 3, gap: 3 })
      return { title: 'Your mix', tracks: list.map(x => ({ ...x.track, why: x.why })) }
    }

    let radio = await this.d.catalog.artistRadio(seedArtist).catch(() => [] as MusicTrack[])
    if (radio.length < 10) radio = [...radio, ...(await this.d.catalog.artistPage({ ...seedArtist, ...this.d.store.get(seedArtist.id) }, true).then(p => p.top).catch(() => []))]
    this.remember(radio)
    const pools = [byPosition(radio, t => (t.artist.id === seedArtist.id ? `More ${seedArtist.name}` : `Sounds like ${seedArtist.name}`))]
    if (exclude.size > 20) {
      // A long session: widen to artists next to this one so it doesn't loop.
      const near = (await this.d.catalog.related(seedArtist, 6).catch(() => [])).slice(0, 2)
      const more = await Promise.all(near.map(a => this.d.catalog.artistRadio(a, 25).then(t => this.remember(t)).catch(() => [] as MusicTrack[])))
      pools.push(...more.map((r, i) => byPosition(r, () => `Close to ${near[i].name}`, 0.1).map(x => ({ ...x, fit: x.fit * 0.7 }))))
    }
    if (seedTrack) exclude.add(seedTrack.id)
    const list = arrange(this.scoreAll(taste, merge(pools), { now: at, tasteWeight: 0.35, exclude, seed: at }), { size: 30, perArtist: 4, gap: 2 })
    const tracks: MusicTrack[] = list.map(x => ({ ...x.track, why: x.why }))
    if (seedTrack && !req.exclude?.includes(seedTrack.id)) tracks.unshift(seedTrack)
    return { title: `${seedTrack ? seedTrack.title : seedArtist.name} radio`, tracks }
  }

  /** Some words without AI: the best playlists for them, re-ranked for this listener. */
  private async moodMix (profile: Profile, taste: Taste, mood: string, exclude: Set<string>, keep: boolean): Promise<MusicRadioResponse> {
    const words = mood.trim().slice(0, 80)
    const lists = await this.d.catalog.playlistTracks(words).catch(() => [])
    for (const l of lists) this.remember(l.tracks)
    const pool = merge(lists.map((l, i) => byPosition(l.tracks, () => `From “${l.name}”`).map(x => ({ ...x, fit: x.fit * (1 - i * 0.1) }))))
    const list = arrange(this.scoreAll(taste, pool, { now: this.now(), tasteWeight: 0.5, exclude, seed: this.now() }), { size: 35, perArtist: 2, gap: 3 })
    if (!list.length) throw new HttpError(404, `Nothing found for “${words}”. Try other words.`)
    const title = words.charAt(0).toUpperCase() + words.slice(1)
    if (!exclude.size && keep) {
      this.d.store.saveMix(profile.id, { id: mixId(profile.id, 'mood', normName(words)), kind: 'mood', title, subtitle: `From playlists like “${lists[0].name}”, picked for you`, tracks: list.map(x => ({ id: x.track.id, why: x.why })), at: this.now() })
      this.d.store.dropMixes(profile.id, [])
    }
    return { title, tracks: list.map(x => ({ ...x.track, why: x.why })) }
  }

  // ---- AI mixes ----

  private tasteForPrompt (profile: Profile, taste: Taste): string {
    const s = this.d.store
    const line = (t: MusicTrack) => `${t.credit ?? t.artist.name} – ${baseTitle(t.title)}`
    const liked = s.liked(profile.id, 40).map(line)
    const history = s.history(profile.id, this.now() - 90 * DAY)
    const skipped = s.tracks([...new Set(history.filter(l => l.outcome === 'skip').map(l => l.trackId))].slice(0, 15)).map(line)
    const recent = s.tracks([...new Set(history.filter(l => l.outcome === 'complete').map(l => l.trackId))].slice(0, 25)).map(line)
    const artists = seedArtists(taste, 15).map(a => a.name)
    const avoid = [...taste.artists.values()].filter(a => a.score === Number.NEGATIVE_INFINITY && a.name).map(a => a.name)
    const parts = [
      artists.length ? `Artists they play and like most: ${artists.join(', ')}` : '',
      liked.length ? `Songs they love:\n${liked.join('\n')}` : '',
      recent.length ? `Played to the end lately:\n${recent.join('\n')}` : '',
      skipped.length ? `Skipped within 30 seconds:\n${skipped.join('\n')}` : '',
      avoid.length ? `Never play these artists: ${avoid.join(', ')}` : '',
    ].filter(Boolean)
    return parts.length ? parts.join('\n\n') : 'They are new here: no likes or listens yet.'
  }

  async aiMix (profile: Profile, prompt: string | undefined): Promise<MusicMix> {
    const ai = this.d.ai
    if (!ai) throw new HttpError(409, 'Connect ChatGPT, Claude or OpenAI in AI settings first.')
    const taste = this.taste(profile)
    const when = new Date(this.now())
    const part = ['night', 'morning', 'afternoon', 'evening'][Math.floor(((when.getHours() + 21) % 24) / 6)]
    const ask = prompt?.trim()
      ? `Their request: ${prompt.trim().slice(0, 300)}`
      : 'No request: make the mix they would most want right now.'
    const { text, model } = await ai.askMusic({
      system: MUSIC_SYSTEM,
      prompt: `${this.tasteForPrompt(profile, taste)}\n\nIt is ${when.toLocaleDateString('en-GB', { weekday: 'long' })} ${part} where they are.\n\n${ask}`,
      schema: MUSIC_SCHEMA as unknown as Record<string, unknown>,
      effort: 'low',
      maxTokens: 4000,
    })
    let parsed: { title?: string; description?: string; tracks?: Array<{ artist?: string; title?: string; why?: string }> }
    try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { throw new HttpError(502, 'The AI’s answer wasn’t readable. Try again.') }
    const asked = (parsed.tracks ?? []).filter(t => t.artist && t.title).slice(0, 30)
    const found: MusicTrack[] = await this.resolveAll(asked.map(t => ({ artist: String(t.artist), title: String(t.title), why: String(t.why ?? '').slice(0, 90) })))
    const kept = found.filter(t => score(taste, { track: t, fit: 1, why: '' }, { now: this.now(), tasteWeight: 0, allowRecent: true }) !== Number.NEGATIVE_INFINITY)
    if (kept.length < 5) throw new HttpError(502, 'The AI suggested songs that couldn’t be found. Try again or ask differently.')
    const title = String(parsed.title ?? '').trim().slice(0, 40) || 'Your AI mix'
    const mix: SavedMix = {
      id: mixId(profile.id, 'ai', String(this.now())),
      kind: 'ai',
      title,
      subtitle: String(parsed.description ?? '').trim().slice(0, 120) || (prompt ? `“${prompt.trim().slice(0, 60)}”` : 'Picked for you by AI'),
      tracks: kept.map(t => ({ id: t.id, why: t.why })),
      model: model.name,
      at: this.now(),
    }
    this.d.store.saveMix(profile.id, mix)
    this.d.store.dropMixes(profile.id, [])
    this.enrich(kept)
    return this.mix(profile, mix.id)
  }

  /** A model's suggestions as songs: already known, else LRCLIB's record of it, else Apple's (paced). */
  private async resolveAll (list: Array<{ artist: string; title: string; why: string }>): Promise<MusicTrack[]> {
    const out: Array<MusicTrack | null> = new Array(list.length).fill(null)
    let next = 0
    const worker = async () => {
      while (next < list.length) {
        const i = next++
        const s = list[i]
        const t = await this.resolve(s.artist, s.title).catch(() => null)
        if (t) out[i] = { ...t, why: s.why || undefined }
      }
    }
    await Promise.all(Array.from({ length: 5 }, worker))
    const seen = new Set<string>()
    return out.filter((t): t is MusicTrack => Boolean(t) && !seen.has(t!.id) && Boolean(seen.add(t!.id)))
  }

  private async resolve (artist: string, title: string): Promise<MusicTrack | null> {
    const known = this.d.store.track(trackIdOf(artist, title))
    if (known) return known
    const want = normName(baseTitle(title))
    const names = splitCredit(artist).map(normName)
    const list = await this.d.fetch<Array<{ trackName?: string; artistName?: string; albumName?: string; duration?: number }>>(
      `https://lrclib.net/api/search?${new URLSearchParams({ track_name: baseTitle(title), artist_name: artist })}`, { timeoutMs: 10_000, cacheMs: 7 * DAY }).catch(() => [])
    const hit = (Array.isArray(list) ? list : []).find(e => normName(baseTitle(e.trackName ?? '')) === want && splitCredit(e.artistName ?? '').some(n => names.includes(normName(n))))
    if (hit?.trackName && hit.artistName) {
      const credit = hit.artistName
      const first = splitCredit(credit)[0] ?? credit
      const dz = await this.d.catalog.deezerArtist({ id: artistIdOf(first), name: first }).catch(() => null)
      const t: MusicTrack = {
        id: trackIdOf(credit, hit.trackName),
        title: hit.trackName,
        artist: { id: artistIdOf(first), name: first, ...(dz?.picture ? { picture: dz.picture } : {}) },
        ...(credit !== first ? { credit } : {}),
        duration: Math.round(hit.duration ?? 0),
      }
      this.remember([t])
      return this.d.store.track(t.id)
    }
    const apple = await this.d.catalog.findSong(artist, title, true).catch(() => null)
    if (apple) this.remember([apple])
    return apple ? this.d.store.track(apple.id) : null
  }

  /** Album art for songs that came without it, from Apple, in the background and within its pace. */
  private enrich (tracks: MusicTrack[]): void {
    this.enrichQueue.push(...tracks.filter(t => !t.album?.cover).slice(0, 30))
    if (this.enriching) return
    this.enriching = true
    void (async () => {
      while (this.enrichQueue.length) {
        const t = this.enrichQueue.shift()!
        const found = await this.d.catalog.findSong(t.credit ?? t.artist.name, t.title, false).catch(() => null)
        if (found && found.id === t.id) this.remember([found])
      }
    })().finally(() => { this.enriching = false })
  }

  // ---- Search and pages ----

  async search (q: string): Promise<MusicSearchResponse> {
    let [tracks, artists] = await Promise.all([
      this.d.catalog.searchSongs(q, 30).catch(err => { this.log(`music: song search failed (${(err as Error).message})`); return [] as MusicTrack[] }),
      this.d.catalog.searchArtists(q, 8).catch(() => [] as MusicArtist[]),
    ])
    this.remember(tracks)
    // Deezer's artist search is loose ("kesariya" finds "Kariya"): keep artists the words name or who sing a
    // song found.
    const words = normName(q)
    const singers = new Set(tracks.flatMap(t => splitCredit(t.credit ?? t.artist.name).map(artistIdOf)))
    artists = artists.filter(a => singers.has(a.id) || normName(a.name).includes(words) || words.includes(normName(a.name)))
    // Pictures for the artists of the songs found, from the artist search when it has them.
    const pics = new Map(artists.map(a => [a.id, a.picture]))
    const withPics = tracks.map(t => (pics.get(t.artist.id) && !t.artist.picture ? { ...t, artist: { ...t.artist, picture: pics.get(t.artist.id) } } : t))
    const albums = new Map<string, { id: string; title: string; cover?: string; artist?: string }>()
    for (const t of withPics) if (t.album && !albums.has(t.album.id) && !/ - single$/i.test(t.album.title)) albums.set(t.album.id, { ...t.album, artist: t.artist.name })
    return { tracks: withPics, artists, albums: [...albums.values()].slice(0, 10) }
  }

  async artist (profile: Profile, id: string): Promise<MusicArtistPage> {
    const ref = this.d.store.get(id) ?? (this.d.store.artist(id) ? { ...this.d.store.artist(id)! } : null)
    if (!ref) throw new HttpError(404, 'Artist not found')
    const [page, related, dz] = await Promise.all([
      this.d.catalog.artistPage(ref).catch(() => ({ top: [], albums: [] })),
      this.d.catalog.related(ref, 16).catch(() => [] as MusicArtist[]),
      ref.picture ? Promise.resolve(null) : this.d.catalog.deezerArtist(ref).catch(() => null),
    ])
    const picture = ref.picture ?? dz?.picture
    const top = page.top.length ? page.top : (await this.d.catalog.artistRadio(ref, 40).catch(() => [])).filter(t => t.artist.id === id)
    this.remember(top)
    return {
      artist: { id, name: ref.name, ...(picture ? { picture } : {}) },
      top: top.slice(0, 20).map(t => (t.artist.id === id && picture && !t.artist.picture ? { ...t, artist: { ...t.artist, picture } } : t)),
      albums: page.albums.slice(0, 30),
      related,
      rating: this.d.store.rating(profile.id, 'artist', id),
    }
  }

  async album (id: string): Promise<MusicAlbum> {
    const a = await this.d.catalog.album(id).catch(err => { throw new HttpError(502, `Couldn’t load this album (${(err as Error).message})`) })
    if (!a) throw new HttpError(404, 'Album not found')
    this.remember(a.tracks)
    return a
  }

  /** Popular artists to choose from on a first visit. */
  async starters (): Promise<MusicArtist[]> {
    if (this.startersCache && this.now() - this.startersCache.at < 6 * 3600_000) return this.startersCache.list
    const chart = await this.d.catalog.chart(100).catch(() => [] as MusicTrack[])
    const seen = new Set<string>()
    const names: MusicArtist[] = []
    for (const t of chart) for (const n of splitCredit(t.credit ?? t.artist.name)) {
      const id = artistIdOf(n)
      if (!seen.has(id)) { seen.add(id); names.push({ id, name: n }) }
    }
    const withPics = await Promise.all(names.slice(0, 30).map(a => this.d.catalog.deezerArtist(a).then(d => (d?.picture ? { ...a, picture: d.picture } : a)).catch(() => a)))
    const list = withPics.filter(a => a.picture).slice(0, 24)
    if (list.length) this.startersCache = { at: this.now(), list }
    return list
  }

  // ---- Likes and listens ----

  rate (profile: Profile, kind: 'track' | 'artist', id: string, rating: 1 | -1 | 0): void {
    const artist = kind === 'artist' ? this.d.store.artist(id) : null
    const track = kind === 'track' ? this.d.store.track(id) : null
    if (!artist && !track) throw new HttpError(404, kind === 'artist' ? 'Artist not found' : 'Song not found')
    const name = artist?.name ?? track!.title
    const picture = artist ? artist.picture : track!.album?.cover
    this.d.store.rate(profile.id, kind, id, rating, { name, picture })
  }

  rating (profile: Profile, trackId: string): 1 | -1 | 0 { return this.d.store.rating(profile.id, 'track', trackId) }

  listen (profile: Profile, trackId: string, played: number, how: 'ended' | 'skipped' | 'left'): void {
    const t = this.d.store.track(trackId)
    if (!t) return
    this.d.store.listen(profile.id, t, played, how)
  }

  // ---- Songs and lyrics ----

  track (id: string): MusicTrack {
    const t = this.d.store.track(id)
    if (!t) throw new HttpError(404, 'Song not found')
    return t
  }

  lyrics (id: string): Promise<MusicLyrics> {
    return this.d.lyrics.for(this.track(id))
  }

  /** Gets the next songs ready, so they start at once. */
  prefetch (ids: string[]): void {
    for (const id of ids.slice(0, 2)) {
      const t = this.d.store.track(id)
      if (t) this.d.files.ensure(t, 'audio').catch(() => {})
    }
  }
}
