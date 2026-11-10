import { bad, HttpError } from './http.ts'
import { IMDB_ID, match, nullable, num, object, oneOf, plainText, STREAM_ID, time, UUID } from './validate.ts'

// The sync wire format: types, limits and the validator for a push. Pure (no Worker APIs), so the local
// Node server can import it to check a batch before sending it. README.md documents the same format.

export const LIMITS = {
  pushBytes: 256 * 1024,
  pushItems: 500,
  profilesPerAccount: 50,
  pullDefault: 500,
  pullMax: 1000,
}

const KINDS = ['rating', 'list', 'play', 'progress', 'complete', 'dismiss', 'forget', 'hide', 'pref'] as const
export type Kind = typeof KINDS[number]
const TYPES = ['movie', 'series'] as const
export type MediaType = typeof TYPES[number]
const REASONS = ['not_interested', 'seen'] as const
const RATING_SOURCE = /^[a-z][a-z0-9_-]{0,31}$/
const FEATURE = /^(g|gg|gd|dec|d|w|p|c):(.{1,120})$/s
const MAX_SECONDS = 86_400
const MAX_WATCHED = 10_000_000

const CONTEXT_KEYS: Record<Kind, string[]> = {
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
