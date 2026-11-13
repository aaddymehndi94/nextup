import { bad, HttpError } from './errors.ts'
import {
  ALBUM_ID, ARTIST_ID, CATALOG_ID, catalogText, IMDB_ID, imageUrl, int, match, MIX_ID, nullable, num, object, oneOf, plainText, STREAM_ID, time,
  TRACK_ID, UUID,
} from './validate.ts'

// The sync wire format: types, limits and the validator for a push. Pure (no Worker APIs), so the local
// Node server can import it to check a batch before sending it. README.md documents the same format.

export const LIMITS = {
  pushBytes: 256 * 1024,
  pushItems: 500,
  profilesPerAccount: 50,
  pullDefault: 500,
  pullMax: 1000,
  /** Saved AI and mood mixes kept per profile; older ones are dropped (each computer shows its newest 6). */
  musicMixesPerProfile: 12,
}

const KINDS = ['rating', 'list', 'play', 'progress', 'complete', 'dismiss', 'forget', 'hide', 'pref'] as const
export type Kind = typeof KINDS[number]
const TYPES = ['movie', 'series'] as const
export type MediaType = typeof TYPES[number]
const REASONS = ['not_interested', 'seen'] as const
export const RATING_SOURCE = /^[a-z][a-z0-9_-]{0,31}$/
const FEATURE = /^(g|gg|gd|dec|d|w|p|c):(.{1,120})$/s
const MAX_SECONDS = 86_400
const MAX_WATCHED = 10_000_000

/** The context keys each event kind may carry. */
export const CONTEXT_KEYS: Record<Kind, string[]> = {
  rating: ['source'],
  list: [],
  play: ['streamId', 'position', 'duration', 'watchedSec'],
  progress: ['streamId', 'position', 'duration', 'watchedSec'],
  complete: ['streamId', 'position', 'duration', 'watchedSec'],
  dismiss: ['reason'],
  forget: [],
  hide: [],
  pref: ['feature'],
}

// ---- Wire types (also the pull shapes) ---------------------------------------------------

export interface ProfileW { id: string; name: string; avatar: string | null; createdAt: number; updatedAt: number; deletedAt: number | null }
export interface EventContextW { streamId?: string; position?: number; duration?: number; watchedSec?: number; source?: string; reason?: string; feature?: string }
export interface EventW { id: string; profileId: string; kind: Kind; itemId: string | null; itemType: MediaType | null; value: number | null; context: EventContextW | null; at: number }
export interface RatingW { profileId: string; itemId: string; itemType: MediaType; value: -1 | 0 | 1; source: string | null; updatedAt: number }
export interface ListW { profileId: string; itemId: string; itemType: MediaType; inList: 0 | 1; addedAt: number; updatedAt: number }
export interface ProgressW {
  profileId: string; streamId: string; itemId: string; itemType: MediaType; season: number | null; episode: number | null
  position: number; duration: number; maxPosition: number; watchedSec: number; completedAt: number | null
  startedAt: number; updatedAt: number; hidden: 0 | 1; forgotten: 0 | 1
}
export interface DismissalW { profileId: string; itemId: string; itemType: MediaType; reason: 'not_interested' | 'seen' | null; updatedAt: number }
export interface PrefW { profileId: string; feature: string; value: -1 | 0 | 1; updatedAt: number }

export interface Batch {
  profiles: ProfileW[]
  events: EventW[]
  ratings: RatingW[]
  list: ListW[]
  progress: ProgressW[]
  dismissals: DismissalW[]
  prefs: PrefW[]
}

export const SECTIONS = ['profiles', 'events', 'ratings', 'list', 'progress', 'dismissals', 'prefs'] as const
export type Section = typeof SECTIONS[number]

// ---- Validation ---------------------------------------------------------------------------

const uuid = (v: unknown, p: string) => match(v, p, UUID, 'a lowercase UUID')
const imdb = (v: unknown, p: string) => match(v, p, IMDB_ID, 'an IMDb id like tt0133093')
const mediaType = (v: unknown, p: string) => oneOf(v, p, TYPES)
const flag = (v: unknown, p: string) => oneOf(v, p, [0, 1] as const)

/** `tt…` for a movie, `tt…:season:episode` for a series episode, and it must belong to itemId. */
function streamOf (v: unknown, p: string, itemId: string, itemType: MediaType): { streamId: string; season: number | null; episode: number | null } {
  const streamId = match(v, p, STREAM_ID, 'a movie id (tt…) or an episode id (tt…:season:episode)')
  const [, tt, s, e] = STREAM_ID.exec(streamId)!
  if (tt !== itemId) throw bad(`${p}: belongs to ${tt}, not ${itemId}`)
  if (itemType === 'movie' && s !== undefined) throw bad(`${p}: a movie's streamId is its IMDb id`)
  if (itemType === 'series' && s === undefined) throw bad(`${p}: a series needs an episode id (tt…:season:episode)`)
  return { streamId, season: s === undefined ? null : Number(s), episode: e === undefined ? null : Number(e) }
}

function feature (v: unknown, p: string): string {
  const key = plainText(v, p, 124)
  if (!FEATURE.test(key)) throw bad(`${p}: must be a feature key like g:Drama, d:<name>, dec:1990s`)
  return key
}

function vProfile (v: unknown, p: string, now: number): ProfileW {
  const o = object(v, p, ['id', 'name', 'avatar', 'createdAt', 'updatedAt', 'deletedAt'])
  return {
    id: uuid(o.id, `${p}.id`),
    name: plainText(o.name, `${p}.name`, 40),
    avatar: nullable(o.avatar, x => plainText(x, `${p}.avatar`, 64)),
    createdAt: time(o.createdAt, `${p}.createdAt`, now),
    updatedAt: time(o.updatedAt, `${p}.updatedAt`, now),
    deletedAt: nullable(o.deletedAt, x => time(x, `${p}.deletedAt`, now)),
  }
}

function vEvent (v: unknown, p: string, now: number): EventW {
  const o = object(v, p, ['id', 'profileId', 'kind', 'itemId', 'itemType', 'value', 'context', 'at'])
  const kind = oneOf(o.kind, `${p}.kind`, KINDS)
  let itemId: string | null = null
  let itemType: MediaType | null = null
  if (kind === 'pref') {
    if (o.itemId !== null || o.itemType !== null) throw bad(`${p}: a pref event has itemId and itemType null`)
  } else {
    itemId = imdb(o.itemId, `${p}.itemId`)
    itemType = mediaType(o.itemType, `${p}.itemType`)
  }
  const vp = `${p}.value`
  let value: number | null
  switch (kind) {
    case 'rating': case 'pref': value = oneOf(o.value, vp, [-1, 0, 1] as const); break
    case 'list': case 'dismiss': value = oneOf(o.value, vp, [0, 1] as const); break
    case 'play': case 'progress': case 'complete': value = num(o.value, vp, 0, 1); break
    default: if (o.value !== null) throw bad(`${vp}: must be null for ${kind}`); value = null
  }
  let context: EventContextW | null = null
  if (o.context !== null) {
    const cp = `${p}.context`
    const c = object(o.context, cp, [], CONTEXT_KEYS[kind])
    const out: EventContextW = {}
    if (c.streamId !== undefined) out.streamId = streamOf(c.streamId, `${cp}.streamId`, itemId!, itemType!).streamId
    if (c.position !== undefined) out.position = num(c.position, `${cp}.position`, 0, MAX_SECONDS)
    if (c.duration !== undefined) out.duration = num(c.duration, `${cp}.duration`, 0, MAX_SECONDS)
    if (c.watchedSec !== undefined) out.watchedSec = num(c.watchedSec, `${cp}.watchedSec`, 0, MAX_WATCHED)
    if (c.source !== undefined) out.source = match(c.source, `${cp}.source`, RATING_SOURCE, 'a short lowercase word like "title"')
    if (c.reason !== undefined) out.reason = oneOf(c.reason, `${cp}.reason`, REASONS)
    if (c.feature !== undefined) out.feature = feature(c.feature, `${cp}.feature`)
    context = Object.keys(out).length ? out : null
  }
  if (kind === 'pref' && !context?.feature) throw bad(`${p}.context.feature: required for a pref event`)
  return { id: uuid(o.id, `${p}.id`), profileId: uuid(o.profileId, `${p}.profileId`), kind, itemId, itemType, value, context, at: time(o.at, `${p}.at`, now) }
}

function vRating (v: unknown, p: string, now: number): RatingW {
  const o = object(v, p, ['profileId', 'itemId', 'itemType', 'value', 'source', 'updatedAt'])
  return {
    profileId: uuid(o.profileId, `${p}.profileId`),
    itemId: imdb(o.itemId, `${p}.itemId`),
    itemType: mediaType(o.itemType, `${p}.itemType`),
    value: oneOf(o.value, `${p}.value`, [-1, 0, 1] as const),
    source: nullable(o.source, x => match(x, `${p}.source`, RATING_SOURCE, 'a short lowercase word like "title"')),
    updatedAt: time(o.updatedAt, `${p}.updatedAt`, now),
  }
}

function vList (v: unknown, p: string, now: number): ListW {
  const o = object(v, p, ['profileId', 'itemId', 'itemType', 'inList', 'addedAt', 'updatedAt'])
  return {
    profileId: uuid(o.profileId, `${p}.profileId`),
    itemId: imdb(o.itemId, `${p}.itemId`),
    itemType: mediaType(o.itemType, `${p}.itemType`),
    inList: flag(o.inList, `${p}.inList`),
    addedAt: time(o.addedAt, `${p}.addedAt`, now),
    updatedAt: time(o.updatedAt, `${p}.updatedAt`, now),
  }
}

function vProgress (v: unknown, p: string, now: number): ProgressW {
  const o = object(v, p, ['profileId', 'streamId', 'itemId', 'itemType', 'season', 'episode', 'position', 'duration', 'maxPosition',
    'watchedSec', 'completedAt', 'startedAt', 'updatedAt', 'hidden', 'forgotten'])
  const itemId = imdb(o.itemId, `${p}.itemId`)
  const itemType = mediaType(o.itemType, `${p}.itemType`)
  const s = streamOf(o.streamId, `${p}.streamId`, itemId, itemType)
  if (o.season !== s.season || o.episode !== s.episode) throw bad(`${p}: season and episode must match streamId (${s.season}, ${s.episode})`)
  const duration = num(o.duration, `${p}.duration`, 0, MAX_SECONDS)
  if (duration <= 0) throw bad(`${p}.duration: must be more than 0`)
  return {
    profileId: uuid(o.profileId, `${p}.profileId`),
    ...s,
    itemId,
    itemType,
    position: num(o.position, `${p}.position`, 0, MAX_SECONDS),
    duration,
    maxPosition: num(o.maxPosition, `${p}.maxPosition`, 0, MAX_SECONDS),
    watchedSec: num(o.watchedSec, `${p}.watchedSec`, 0, MAX_WATCHED),
    completedAt: nullable(o.completedAt, x => time(x, `${p}.completedAt`, now)),
    startedAt: time(o.startedAt, `${p}.startedAt`, now),
    updatedAt: time(o.updatedAt, `${p}.updatedAt`, now),
    hidden: flag(o.hidden, `${p}.hidden`),
    forgotten: flag(o.forgotten, `${p}.forgotten`),
  }
}

function vDismissal (v: unknown, p: string, now: number): DismissalW {
  const o = object(v, p, ['profileId', 'itemId', 'itemType', 'reason', 'updatedAt'])
  return {
    profileId: uuid(o.profileId, `${p}.profileId`),
    itemId: imdb(o.itemId, `${p}.itemId`),
    itemType: mediaType(o.itemType, `${p}.itemType`),
    reason: nullable(o.reason, x => oneOf(x, `${p}.reason`, REASONS)),
    updatedAt: time(o.updatedAt, `${p}.updatedAt`, now),
  }
}

function vPref (v: unknown, p: string, now: number): PrefW {
  const o = object(v, p, ['profileId', 'feature', 'value', 'updatedAt'])
  return {
    profileId: uuid(o.profileId, `${p}.profileId`),
    feature: feature(o.feature, `${p}.feature`),
    value: oneOf(o.value, `${p}.value`, [-1, 0, 1] as const),
    updatedAt: time(o.updatedAt, `${p}.updatedAt`, now),
  }
}

/** Per-row validators, for clients that want to set aside one bad row instead of failing a whole push. */
export const VALIDATORS: { [S in Section]: (v: unknown, p: string, now: number) => Batch[S][number] } = {
  profiles: vProfile, events: vEvent, ratings: vRating, list: vList, progress: vProgress, dismissals: vDismissal, prefs: vPref,
}

/** Validates a push body into a Batch, or throws a 400 naming the first bad field. */
export function parseBatch (body: Record<string, unknown>, now: number): Batch {
  for (const k of Object.keys(body)) if (!(SECTIONS as readonly string[]).includes(k)) throw bad(`body: unknown field "${k}"`)
  let total = 0
  for (const s of SECTIONS) {
    const arr = body[s]
    if (arr === undefined) continue
    if (!Array.isArray(arr)) throw bad(`${s}: must be an array`)
    total += arr.length
  }
  if (total > LIMITS.pushItems) throw new HttpError(413, 'too_many_items', `At most ${LIMITS.pushItems} items per push (got ${total}); split it into several pushes`)
  const out = {} as Record<Section, unknown[]>
  for (const s of SECTIONS) out[s] = ((body[s] ?? []) as unknown[]).map((v, i) => VALIDATORS[s](v, `${s}[${i}]`, now))
  return out as unknown as Batch
}

// ---- Music (POST /v1/sync/music/push, GET /v1/sync/music/pull) -------------------------------------------
// Its own endpoints and cursor, so clients from before music never see these rows, and a client talking to a
// Worker without them carries on with films. The person's music taste (likes, listens, the mixes they asked
// for) plus the songs and artists those rows name, so another computer can show them. Never the engine's own
// mixes (each computer remakes them), downloads or AI settings.

export const MUSIC_SECTIONS = ['artists', 'tracks', 'ratings', 'listens', 'mixes'] as const
export type MusicSection = typeof MUSIC_SECTIONS[number]
const MUSIC_KINDS = ['track', 'artist'] as const
const OUTCOMES = ['complete', 'partial', 'skip'] as const
/** Mixes someone asked for. Daily, artist, Discover and On repeat mixes are remade on each computer instead. */
export const MIX_KINDS = ['ai', 'mood'] as const
/** Longest text per field, in characters. */
export const MUSIC_TEXT = { name: 200, credit: 300, mixTitle: 80, mixSubtitle: 200, why: 200, model: 64 }
export const MIX_TRACKS_MAX = 60

export interface MusicArtistW { id: string; name: string; picture: string | null; itunesId: string | null; deezerId: string | null }
export interface MusicTrackW {
  id: string; title: string; credit: string | null; artistId: string; artist: string; picture: string | null
  albumId: string | null; album: string | null; cover: string | null; duration: number; explicit: 0 | 1; rank: number
}
export interface MusicRatingW { profileId: string; kind: 'track' | 'artist'; itemId: string; value: -1 | 0 | 1; name: string | null; picture: string | null; updatedAt: number }
export interface MusicListenW { id: string; profileId: string; trackId: string; artistId: string; played: number; outcome: typeof OUTCOMES[number]; at: number }
export interface MixTrackW { id: string; why: string | null }
export interface MusicMixW { id: string; profileId: string; kind: typeof MIX_KINDS[number]; title: string; subtitle: string; tracks: MixTrackW[]; model: string | null; at: number }

export interface MusicBatch {
  artists: MusicArtistW[]
  tracks: MusicTrackW[]
  ratings: MusicRatingW[]
  listens: MusicListenW[]
  mixes: MusicMixW[]
}

const trackId = (v: unknown, p: string) => match(v, p, TRACK_ID, 'a song id (t and 16 hex digits)')
const artistId = (v: unknown, p: string) => match(v, p, ARTIST_ID, 'an artist id (a and 12 hex digits)')
const catalogId = (v: unknown, p: string) => match(v, p, CATALOG_ID, 'a catalog number')
const picture = (v: unknown, p: string) => nullable(v, x => imageUrl(x, p))

function vArtist (v: unknown, p: string): MusicArtistW {
  const o = object(v, p, ['id', 'name', 'picture', 'itunesId', 'deezerId'])
  return {
    id: artistId(o.id, `${p}.id`),
    name: catalogText(o.name, `${p}.name`, MUSIC_TEXT.name),
    picture: picture(o.picture, `${p}.picture`),
    itunesId: nullable(o.itunesId, x => catalogId(x, `${p}.itunesId`)),
    deezerId: nullable(o.deezerId, x => catalogId(x, `${p}.deezerId`)),
  }
}

function vTrack (v: unknown, p: string): MusicTrackW {
  const o = object(v, p, ['id', 'title', 'credit', 'artistId', 'artist', 'picture', 'albumId', 'album', 'cover', 'duration', 'explicit', 'rank'])
  return {
    id: trackId(o.id, `${p}.id`),
    title: catalogText(o.title, `${p}.title`, MUSIC_TEXT.name),
    credit: nullable(o.credit, x => catalogText(x, `${p}.credit`, MUSIC_TEXT.credit)),
    artistId: artistId(o.artistId, `${p}.artistId`),
    artist: catalogText(o.artist, `${p}.artist`, MUSIC_TEXT.name),
    picture: picture(o.picture, `${p}.picture`),
    albumId: nullable(o.albumId, x => match(x, `${p}.albumId`, ALBUM_ID, 'an album id (it… or dz…)')),
    album: nullable(o.album, x => catalogText(x, `${p}.album`, MUSIC_TEXT.name)),
    cover: picture(o.cover, `${p}.cover`),
    duration: int(o.duration, `${p}.duration`, 0, MAX_SECONDS),
    explicit: flag(o.explicit, `${p}.explicit`),
    rank: num(o.rank, `${p}.rank`, 0, 1),
  }
}

function vMusicRating (v: unknown, p: string, now: number): MusicRatingW {
  const o = object(v, p, ['profileId', 'kind', 'itemId', 'value', 'name', 'picture', 'updatedAt'])
  const kind = oneOf(o.kind, `${p}.kind`, MUSIC_KINDS)
  return {
    profileId: uuid(o.profileId, `${p}.profileId`),
    kind,
    itemId: kind === 'track' ? trackId(o.itemId, `${p}.itemId`) : artistId(o.itemId, `${p}.itemId`),
    value: oneOf(o.value, `${p}.value`, [-1, 0, 1] as const),
    name: nullable(o.name, x => catalogText(x, `${p}.name`, MUSIC_TEXT.name)),
    picture: picture(o.picture, `${p}.picture`),
    updatedAt: time(o.updatedAt, `${p}.updatedAt`, now),
  }
}

function vListen (v: unknown, p: string, now: number): MusicListenW {
  const o = object(v, p, ['id', 'profileId', 'trackId', 'artistId', 'played', 'outcome', 'at'])
  return {
    id: uuid(o.id, `${p}.id`),
    profileId: uuid(o.profileId, `${p}.profileId`),
    trackId: trackId(o.trackId, `${p}.trackId`),
    artistId: artistId(o.artistId, `${p}.artistId`),
    played: num(o.played, `${p}.played`, 0, MAX_SECONDS),
    outcome: oneOf(o.outcome, `${p}.outcome`, OUTCOMES),
    at: time(o.at, `${p}.at`, now),
  }
}

function vMix (v: unknown, p: string, now: number): MusicMixW {
  const o = object(v, p, ['id', 'profileId', 'kind', 'title', 'subtitle', 'tracks', 'model', 'at'])
  if (!Array.isArray(o.tracks) || o.tracks.length < 1 || o.tracks.length > MIX_TRACKS_MAX) throw bad(`${p}.tracks: must be an array of 1–${MIX_TRACKS_MAX} songs`)
  return {
    id: match(o.id, `${p}.id`, MIX_ID, 'a mix id (m and 15 hex digits)'),
    profileId: uuid(o.profileId, `${p}.profileId`),
    kind: oneOf(o.kind, `${p}.kind`, MIX_KINDS),
    title: catalogText(o.title, `${p}.title`, MUSIC_TEXT.mixTitle),
    subtitle: catalogText(o.subtitle, `${p}.subtitle`, MUSIC_TEXT.mixSubtitle),
    tracks: o.tracks.map((t, i) => {
      const tp = `${p}.tracks[${i}]`
      const x = object(t, tp, ['id', 'why'])
      return { id: trackId(x.id, `${tp}.id`), why: nullable(x.why, w => catalogText(w, `${tp}.why`, MUSIC_TEXT.why)) }
    }),
    model: nullable(o.model, x => catalogText(x, `${p}.model`, MUSIC_TEXT.model)),
    at: time(o.at, `${p}.at`, now),
  }
}

/** Per-row validators for music, as VALIDATORS is for films. */
export const MUSIC_VALIDATORS: { [S in MusicSection]: (v: unknown, p: string, now: number) => MusicBatch[S][number] } = {
  artists: vArtist, tracks: vTrack, ratings: vMusicRating, listens: vListen, mixes: vMix,
}

/** Validates a music push body, or throws a 400 naming the first bad field. Same size limits as films. */
export function parseMusicBatch (body: Record<string, unknown>, now: number): MusicBatch {
  for (const k of Object.keys(body)) if (!(MUSIC_SECTIONS as readonly string[]).includes(k)) throw bad(`body: unknown field "${k}"`)
  let total = 0
  for (const s of MUSIC_SECTIONS) {
    const arr = body[s]
    if (arr === undefined) continue
    if (!Array.isArray(arr)) throw bad(`${s}: must be an array`)
    total += arr.length
  }
  if (total > LIMITS.pushItems) throw new HttpError(413, 'too_many_items', `At most ${LIMITS.pushItems} items per push (got ${total}); split it into several pushes`)
  const out = {} as Record<MusicSection, unknown[]>
  for (const s of MUSIC_SECTIONS) out[s] = ((body[s] ?? []) as unknown[]).map((v, i) => MUSIC_VALIDATORS[s](v, `${s}[${i}]`, now))
  return out as unknown as MusicBatch
}
