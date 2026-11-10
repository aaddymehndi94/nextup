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
