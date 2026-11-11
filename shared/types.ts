// API contract shared by the server and the web client.
// Type-only module: safe to import from both sides with `import type`.

export type MediaType = 'movie' | 'series'

/** A search / catalog result. `id` is an IMDb id (tt…). */
export interface TitleSummary {
  id: string
  type: MediaType
  name: string
  year?: string
  poster?: string
}

export interface Episode {
  /** Stream id understood by source providers: `tt0903747:1:1` */
  id: string
  season: number
  episode: number
  name: string
  released?: string
  thumbnail?: string
  overview?: string
}

export interface TitleDetail extends TitleSummary {
  background?: string
  logo?: string
  description?: string
  runtime?: string
  genres: string[]
  imdbRating?: string
  cast: string[]
  director: string[]
  /** Only for series, sorted by season then episode. Season 0 = specials. */
  episodes: Episode[]
}

export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'unknown'

/** What we could infer about a release purely from its name. */
export interface ReleaseInfo {
  resolution: Resolution
  /** BluRay, WEB-DL, WEBRip, HDTV, REMUX, CAM, TS, … */
  source?: string
  /** h264, hevc, av1, xvid, … (lowercase) */
  videoCodec?: string
  hdr: string[]
  tenBit: boolean
  /** aac, ac3, eac3, dts, truehd, opus, flac, … (lowercase) */
  audio: string[]
  /** CAM / TS / screener / telesync releases */
  lowQuality: boolean
  /** File extension of the video file if known (mkv, mp4, avi, …) */
  container?: string
}

/** One torrent that can satisfy a title/episode. */
export interface Source {
  infoHash: string
  /** Index of the video file inside the torrent, if the provider knows it. */
  fileIdx?: number
  /** Name of the video file inside the torrent, if known. */
  fileName?: string
  /** Full release title (torrent name). */
  title: string
  sizeBytes?: number
  /** Seeders as reported by the indexer (may be stale). */
  seeders?: number
  leechers?: number
  /** Indexer names, e.g. "1337x", "ThePirateBay". */
  providers: string[]
  languages: string[]
  trackers: string[]
  release: ReleaseInfo
  /** Ranking score, higher is better. */
  score: number
  /** Short human reasons behind the ranking ("Plays without conversion", "Very healthy swarm"). */
  notes: string[]
}

export interface SourcesResponse {
  sources: Source[]
  /** Provider name → error message, for providers that failed. */
  errors: Record<string, string>
}

/** Live swarm health from a UDP tracker scrape. */
export interface SwarmHealth {
  seeders: number
  leechers: number
  completed: number
}
export type HealthResponse = Record<string, SwarmHealth>

export type PlaybackMode = 'direct' | 'remux' | 'transcode'

export interface StreamInfo {
  index: number
  codec: string
  language?: string
  title?: string
  channels?: number
  default: boolean
}

export interface ProbeResult {
  durationSec: number
  container: string
  /** `index` is relative among video streams (ffmpeg `0:v:N`). */
  video?: { index: number; codec: string; profile?: string; pixFmt?: string; width: number; height: number; hdr: boolean }
  audio: StreamInfo[]
  subtitles: StreamInfo[]
}

/** Codecs the client says it can decode. Sent as query params on probe. */
export interface ClientCaps {
  h264: boolean
  hevc: boolean
  hevc10: boolean
  av1: boolean
  vp9: boolean
  aac: boolean
  ac3: boolean
  eac3: boolean
  opus: boolean
  mp3: boolean
  flac: boolean
}

export interface PlaybackPlan {
  mode: PlaybackMode
  /** Index into ProbeResult.audio of the track to play. */
  audioTrack: number
  copyVideo: boolean
  copyAudio: boolean
  reason: string
}

export interface SessionStats {
  id: string
  infoHash: string
  name: string
  fileName: string
  fileSize: number
  state: 'metadata' | 'ready' | 'error'
  error?: string
  peers: number
  downloadSpeed: number
  uploadSpeed: number
  /** Bytes of this file verified on disk. */
  downloaded: number
  /** 0..1 progress of this file. */
  progress: number
  /** True when the whole file is being kept for offline viewing. */
  pinned: boolean
}

export interface OpenSessionRequest {
  infoHash: string
  fileIdx?: number
  fileName?: string
  trackers?: string[]
  title?: string
}

export interface ProbeResponse {
  probe: ProbeResult
  plan: PlaybackPlan
}

export interface SubtitleTrack {
  id: string
  lang: string
  /** URL on our server returning WebVTT. */
  url: string
}

// ---- Profiles, taste and recommendations -----------------------------------------
// Every /api/me/* route acts on the profile named by the `x-nexttupp-profile` request header
// (falls back to the first profile when absent, and a "Me" profile is created when none exists).

export interface Profile {
  /** UUIDv7. */
  id: string
  name: string
  /** Free-form avatar key chosen by the client (a colour, an emoji, an image name). */
  avatar?: string
  createdAt: number
}

export interface CreateProfileRequest { name: string; avatar?: string }
export interface UpdateProfileRequest { name?: string; avatar?: string | null }

/** 1 = like, -1 = dislike, 0 = no rating. */
export type Rating = 1 | -1 | 0
export type DismissReason = 'not_interested' | 'seen'

export interface WatchProgress {
  /** Movie id, or `tt…:season:episode` for an episode. */
  streamId: string
  season?: number
  episode?: number
  /** Seconds. */
  position: number
  duration: number
  /** position / duration, 0..1 */
  fraction: number
  completed: boolean
  updatedAt: number
}

/** What this profile has done with one title. */
export interface TitleState {
  rating: Rating
  inList: boolean
  /** Latest progress (for a series: the most recently watched episode). Use it to offer "Resume". */
  progress: WatchProgress | null
  /** Series only: every episode this profile has started, in episode order (for watched marks). */
  episodes?: WatchProgress[]
  dismissed: DismissReason | null
}

export interface RatingRequest { value: Rating; /** Where the rating was given, e.g. 'title', 'player', 'onboarding'. */ source?: string }
export interface DismissRequest { reason: DismissReason }
/** Sent by the player every ~10 s while playing, and on pause/exit. */
export interface ProgressRequest {
  type: MediaType; id: string; streamId: string; position: number; duration: number
  /** Where the title was opened from: a home row id ("top", "because:tt…", "discover:g:Western"), "search", "similar". */
  from?: string
}
export interface ProgressResponse { progress: WatchProgress }

export type ReasonKind =
  | 'liked' | 'person' | 'genre' | 'cf' | 'quality' | 'explore' | 'continue' | 'list' | 'similar' | 'popular'

export interface RecReason {
  kind: ReasonKind
  /** Ready to show: "Because you liked Arrival", "More from Denis Villeneuve", "Romantic dramas you rate highly". */
  text: string
  /** The title the reason points at, when there is one. */
  seed?: { id: string; type: MediaType; name: string }
}

export interface RecItem extends TitleSummary {
  background?: string
  logo?: string
  /** Trimmed to ~240 characters. */
  description?: string
  genres: string[]
  imdbRating?: string
  runtime?: string
  reason: RecReason
  /** Continue watching: where the viewer is. */
  progress?: WatchProgress
  /** Continue watching: what Play should open (an episode id for series, possibly the next episode). */
  streamId?: string
}

export type HomeRowKind =
  | 'continue' | 'list' | 'onboarding' | 'top' | 'because' | 'genre' | 'series' | 'movies' | 'different'
  | 'popular' | 'acclaimed' | 'discover'

export interface HomeRow {
  /** Stable within a rotation window; use as a React key. */
  id: string
  kind: HomeRowKind
  title: string
  subtitle?: string
  items: RecItem[]
  /** Discover rows: the feature the row is about, for "More like this" / "Not for me" (PUT /api/me/taste/feature). */
  feature?: { key: string; label: string }
}

export interface HomeResponse {
  profile: Profile
  /** Too few signals to personalise: rows are quality-weighted popular titles and onboarding is offered. */
  coldStart: boolean
  /** Background work (metadata, candidate expansion) is still filling in; refetch in a few seconds for fuller rows. */
  warming: boolean
  rows: HomeRow[]
  /** More rows follow: GET /api/me/home/more?from=<rows.length>, as the viewer scrolls down. */
  more?: boolean
}

export interface HomeMoreResponse { rows: HomeRow[]; more: boolean }
/** GET /api/me/row?id=<row id>&have=<ids already in the row>: the row's next titles, empty when it can't go on. */
export interface RowMoreResponse { items: RecItem[] }

export interface SimilarResponse { items: RecItem[] }

export interface OnboardingResponse {
  /** Diverse, well-known titles this profile hasn't rated; reason.text is a short descriptor ("Crime · 1994"). */
  items: RecItem[]
  /** Titles this profile has rated so far (likes and dislikes). */
  rated: number
  /** Positive signals so far (likes, finished titles): progress towards `target`. Dislikes don't count. */
  positives: number
  /** Positive signals needed before the home screen personalises. */
  target: number
}

export type TasteFeatureKind = 'genre' | 'genres' | 'era' | 'decade' | 'director' | 'writer' | 'cast' | 'country'

export interface TasteFeature {
  /** Stable key such as "d:denis villeneuve" or "g:Sci-Fi"; pass it to PUT /api/me/taste/feature. */
  key: string
  kind: TasteFeatureKind
  /** "Denis Villeneuve", "Romantic dramas", "90s action". */
  label: string
  /** -1..1: how strongly this shows up in the profile's likes (or dislikes). */
  weight: number
  /** Names of the titles behind it. */
  evidence: string[]
  /** The viewer's own override: 1 = more of this, -1 = never show it. */
  pref?: 1 | -1
}

export interface TasteSignal {
  item: TitleSummary
  /** Current weight after decay, -1..1.25. */
  weight: number
  /** "Liked", "Disliked", "Finished", "Watched 4 episodes", "On your list", "Stopped early", "Not interested", "Played briefly". */
  label: string
  at: number
}

export interface TasteSummary {
  profile: Profile
  coldStart: boolean
  /** 0..1, how much the home screen leans on this profile's signals versus general quality. */
  confidence: number
  counts: { positive: number; negative: number; total: number }
  /** One readable sentence. */
  summary: string
  likes: TasteFeature[]
  dislikes: TasteFeature[]
  /** Features the viewer has explicitly boosted or blocked. */
  prefs: TasteFeature[]
  /** Strongest signals first. Each can be undone with the rating/list/progress/dismiss routes. */
  signals: TasteSignal[]
  cf: { available: boolean; covered: number }
}

export interface FeaturePrefRequest { feature: string; value: 1 | -1 | 0 }
