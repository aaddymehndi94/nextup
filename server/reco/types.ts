import type { DismissReason, MediaType } from '../../shared/types.ts'
import type { Scored } from './cf.ts'

// Plain-data inputs to the recommender. Everything in server/reco/ except cf.ts is pure: no I/O, no
// node:* imports, no clock or randomness of its own (callers pass `now` and a rotation seed), so it can
// run in a Worker or a browser as well as here. The adapters in server/taste/ do the I/O.

export interface ItemRef { id: string; type: MediaType }

/** Title metadata as cached from Cinemeta. */
export interface ItemMeta extends ItemRef {
  name: string
  year?: number
  /** Series: last year, if ended. */
  yearEnd?: number
  /** ISO date. */
  released?: string
  poster?: string
  background?: string
  logo?: string
  description?: string
  genres: string[]
  cast: string[]
  directors: string[]
  writers: string[]
  countries: string[]
  /** Minutes. */
  runtime?: number
  imdbRating?: number
  /** TMDB popularity as relayed by Cinemeta (unbounded, ~0.5–600). */
  popularity?: number
  /** TMDB id, kept for future use. */
  moviedbId?: number
  /** Series: [season, episode] pairs in order, season 0 excluded. Only after a full meta fetch. */
  episodes?: Array<[number, number]>
  fetchedAt: number
}

export interface RatingRow extends ItemRef { value: 1 | -1; source?: string; at: number }
export interface ListRow extends ItemRef { addedAt: number; at: number }
export interface DismissalRow extends ItemRef { reason: DismissReason; at: number }
export interface ProgressRow extends ItemRef {
  /** Movie id or `tt…:season:episode`. */
  streamId: string
  season?: number
  episode?: number
  position: number
  duration: number
  maxPosition: number
  /** Seconds of real playback (seeks excluded). */
  watchedSec: number
  completedAt?: number
  startedAt: number
  updatedAt: number
  /** Removed from Continue watching (still counts as taste). */
  hidden: boolean
}

/** Everything about one profile's taste, read in one go. */
export interface TasteSnapshot {
  ratings: RatingRow[]
  list: ListRow[]
  progress: ProgressRow[]
  dismissals: DismissalRow[]
  /** Feature key → 1 (more of this) / -1 (never show). */
  prefs: Map<string, 1 | -1>
}

export interface Impression { count: number; firstAt: number; lastAt: number }

/** Collaborative-filtering results for one request, precomputed by the adapter from CfModel. */
export interface CfData {
  /** CfModel.score(seeds) for this profile's movie signals, best first. */
  scores: Scored[]
  /** Candidate ids the model knows. Movies it doesn't know (series, recent releases) are ranked on content alone. */
  known: Set<string>
  /** Seed id → its CF neighbours, used for "Because you liked X" rows and reasons. */
  neighbors: Map<string, Scored[]>
}
