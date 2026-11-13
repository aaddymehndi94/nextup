// Music: what the server and the web app say to each other. See docs/adr/0010-music.md.

// Ids: songs are `t` + 16 hex and artists `a` + 12 hex, both made from the normalised names, so the same
// song from Apple's catalog and from Deezer is one song. Albums are `it<collectionId>` (Apple) or `dz<id>`.
export interface MusicArtist { id: string; name: string; picture?: string }
export interface MusicAlbumRef { id: string; title: string; cover?: string }

export interface MusicTrack {
  id: string
  title: string
  /** The first credited artist (their page). */
  artist: MusicArtist
  /** Everyone credited, as the catalog writes it: "Pritam, Arijit Singh & Amitabh Bhattacharya". */
  credit?: string
  album?: MusicAlbumRef
  /** Seconds. */
  duration: number
  explicit?: boolean
  /** Popularity, 0–1, when the catalog says. */
  rank?: number
  /** Why it's here, for recommended tracks: "Because you like Arijit Singh". */
  why?: string
}

export interface MusicAlbum extends MusicAlbumRef {
  artist: MusicArtist
  year?: number
  tracks: MusicTrack[]
}

export interface MusicArtistPage {
  artist: MusicArtist & { fans?: number }
  top: MusicTrack[]
  albums: Array<MusicAlbumRef & { year?: number; kind?: string }>
  related: MusicArtist[]
  rating: 1 | -1 | 0
}

export type MixKind = 'daily' | 'artist' | 'discover' | 'repeat' | 'mood' | 'ai' | 'radio' | 'liked' | 'chart'

export interface MusicMix {
  id: string
  kind: MixKind
  title: string
  subtitle: string
  /** Up to four covers for the card. */
  covers: string[]
  tracks: MusicTrack[]
  /** The model's name, for AI mixes. */
  model?: string
  at: number
}

/** A mix as a card on Music home (tracks load when it's opened or played). */
export type MusicMixCard = Omit<MusicMix, 'tracks'> & { count: number }

export interface MusicSetup {
  /** Songs can play: the helper that fetches them is on this computer. */
  ready: boolean
  source: 'youtube' | 'fake'
  helper: 'ok' | 'missing' | 'installing' | 'error'
  message?: string
  /** While installing: how much has downloaded, from 0 to 1, when the size is known. */
  progress?: number
  /** This page can press "Set up music" (only on the computer itself). */
  canInstall: boolean
}

export interface MusicHome {
  setup: MusicSetup
  /** No likes or listens yet: show "Pick a few artists you love". */
  needsSeeds: boolean
  mixes: MusicMixCard[]
  recent: MusicTrack[]
  liked: MusicTrack[]
  likedCount: number
  artists: MusicArtist[]
  trending: MusicTrack[]
  ai: { available: boolean; hint?: string }
}

export interface MusicSearchResponse { tracks: MusicTrack[]; artists: MusicArtist[]; albums: Array<MusicAlbumRef & { artist?: string }> }

export interface LyricLine { t: number; text: string }
export interface MusicLyrics { synced: LyricLine[] | null; plain: string | null; instrumental: boolean }

/** How a listen ended, sent once per track. */
export interface MusicListen { trackId: string; played: number; how: 'ended' | 'skipped' | 'left' }

export interface MusicRateRequest { kind: 'track' | 'artist'; id: string; rating: 1 | -1 | 0 }

export interface MusicRadioRequest {
  /** Start from a song or an artist; with neither, a mix from the listener's taste. */
  track?: string
  artist?: string
  /** Words: "rainy evening", "workout", "90s Bollywood". */
  mood?: string
  /** Already queued or played this session: don't repeat them. */
  exclude?: string[]
}

export interface MusicRadioResponse { title: string; tracks: MusicTrack[] }

export type MusicCastMode = 'audio' | 'lyrics' | 'video'

export interface MusicCastStatus {
  active: boolean
  device?: { id: string; name: string }
  mode?: MusicCastMode
  state?: 'connecting' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'stopped' | 'error'
  /** The queue the TV plays through, and where it is. */
  queue?: MusicTrack[]
  index?: number
  position?: number
  duration?: number
  volume?: number | null
  muted?: boolean
  /** Modes this computer can send (lyrics need ffmpeg with libass). */
  modes?: MusicCastMode[]
  error?: string
}

export interface MusicCastRequest { deviceId: string; queue: string[]; index: number; t: number; mode: MusicCastMode }

/** The same artwork at another size (Apple and Deezer both put the size in the URL). */
export function artSize (url: string | undefined, px: number): string | undefined {
  if (!url) return url
  return url.replace(/\/\d+x\d+bb\./, `/${px}x${px}bb.`).replace(/\/\d+x\d+-000000-/, `/${px}x${px}-000000-`)
}
