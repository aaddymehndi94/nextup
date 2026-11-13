import type { FastifyInstance, FastifyRequest } from 'fastify'
import type {
  CreateProfileRequest, DismissRequest, FeaturePrefRequest, MediaType, Profile, ProgressRequest, RatingRequest, TitleMarks, UpdateProfileRequest,
} from '../../shared/types.ts'
import { plainText } from '../../cloud/src/validate.ts'
import { UUID } from '../db.ts'
import { HttpError } from '../http.ts'
import { hasPrivateHeader, refuseInPrivate } from '../private.ts'
import { isTunableFeature } from '../reco/taste.ts'
import type { TasteStore } from '../store.ts'
import type { RecoService } from './service.ts'

// Profiles, per-profile taste state and recommendations. The active profile comes from the
// `x-nexttupp-profile` header; without it, the first profile (auto-created as "Me").

export const PROFILE_HEADER = 'x-nexttupp-profile'
const IMDB_ID = /^tt\d{1,10}$/
const STREAM_ID = /^tt\d{1,10}(:\d{1,4}:\d{1,5})?$/
const MAX_PROFILES = 12

type TitleParams = { Params: { type: string; id: string } }

function title (params: { type: string; id: string }): { type: MediaType; id: string } {
  const { type, id } = params
  if ((type !== 'movie' && type !== 'series') || !IMDB_ID.test(id)) throw new HttpError(400, 'Bad title id')
  return { type, id }
}

function profileName (v: unknown): string {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 40) throw new HttpError(400, 'Name must be 1–40 characters')
  // The same rules the sync service applies, so every profile can sync: no links, file names or long codes.
  try { plainText(name, 'name', 40) } catch { throw new HttpError(400, 'Use a plain name, without links, file names or long codes') }
  return name
}

function avatar (v: unknown): string | null | undefined {
  if (v === undefined || v === null) return v
  if (typeof v !== 'string' || v.length > 64) throw new HttpError(400, 'Bad avatar')
  return v
}

/** The profile a request is for: the `x-nexttupp-profile` header, or the first profile. */
export function profileFrom (store: TasteStore, req: FastifyRequest): Profile {
  const h = req.headers[PROFILE_HEADER]
  if (typeof h === 'string' && h) {
    if (!UUID.test(h)) throw new HttpError(400, 'Bad profile id')
    const p = store.getProfile(h)
    if (!p) throw new HttpError(404, 'That profile no longer exists. Choose a profile again.')
    return p
  }
  return store.defaultProfile()
}

export function registerTasteRoutes (app: FastifyInstance, store: TasteStore, reco: RecoService): void {
  // Private mode saves nothing: no likes, list, progress, dismissals, taste tuning or profile changes.
  app.addHook('preHandler', async req => {
    if (req.method === 'GET' || req.method === 'HEAD') return
    const path = req.url.split('?')[0]
    if (path.startsWith('/api/me/') || path === '/api/profiles' || path.startsWith('/api/profiles/')) {
      refuseInPrivate(req, 'like titles, change My List or edit profiles')
    }
  })

  const profileOf = (req: FastifyRequest): Profile => profileFrom(store, req)

  // ---- Profiles ----------------------------------------------------------------

  app.get('/api/profiles', async () => {
    store.defaultProfile()
    return store.listProfiles()
  })

  app.post<{ Body: CreateProfileRequest }>('/api/profiles', async (req, reply) => {
    if (store.listProfiles().length >= MAX_PROFILES) throw new HttpError(409, `At most ${MAX_PROFILES} profiles`)
    const p = store.createProfile({ name: profileName(req.body?.name), avatar: avatar(req.body?.avatar) ?? undefined })
    return reply.code(201).send(p)
  })

  app.patch<{ Params: { id: string }; Body: UpdateProfileRequest }>('/api/profiles/:id', async req => {
    if (!UUID.test(req.params.id)) throw new HttpError(400, 'Bad profile id')
    const body = req.body ?? {}
    const p = store.updateProfile(req.params.id, { name: body.name === undefined ? undefined : profileName(body.name), avatar: avatar(body.avatar) })
    if (!p) throw new HttpError(404, 'Profile not found')
    return p
  })

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    if (!UUID.test(req.params.id) || !store.getProfile(req.params.id)) throw new HttpError(404, 'Profile not found')
    if (store.listProfiles().length <= 1) throw new HttpError(409, 'Can’t delete the only profile')
    store.deleteProfile(req.params.id)
    return reply.code(204).send()
  })

  app.get('/api/me', async req => ({ profile: profileOf(req) }))

  // ---- Taste state -----------------------------------------------------------------

  app.get<TitleParams>('/api/me/state/:type/:id', async req => store.titleState(profileOf(req).id, title(req.params)))

  app.get('/api/me/marks', async (req): Promise<TitleMarks> => {
    const s = store.snapshot(profileOf(req).id)
    return { ratings: Object.fromEntries(s.ratings.map(r => [r.id, r.value])), list: s.list.map(l => l.id) }
  })

  app.put<TitleParams & { Body: RatingRequest }>('/api/me/rating/:type/:id', async req => {
    const p = profileOf(req)
    const t = title(req.params)
    const value = req.body?.value
    if (value !== 1 && value !== -1 && value !== 0) throw new HttpError(400, 'value must be 1, -1 or 0')
    const source = typeof req.body?.source === 'string' ? req.body.source.slice(0, 32) : undefined
    store.setRating(p.id, t, value, source)
    return store.titleState(p.id, t)
  })

  app.get('/api/me/list', async req => reco.myList(profileOf(req)))

  app.put<TitleParams>('/api/me/list/:type/:id', async req => {
    const p = profileOf(req)
    const t = title(req.params)
    store.setInList(p.id, t, true)
    return store.titleState(p.id, t)
  })

  app.delete<TitleParams>('/api/me/list/:type/:id', async req => {
    const p = profileOf(req)
    const t = title(req.params)
    store.setInList(p.id, t, false)
    return store.titleState(p.id, t)
  })

  app.post<{ Body: ProgressRequest }>('/api/me/progress', async req => {
    const p = profileOf(req)
    const b = req.body ?? ({} as ProgressRequest)
    const t = title({ type: b.type, id: b.id })
    if (typeof b.streamId !== 'string' || !STREAM_ID.test(b.streamId) || (b.streamId !== t.id && !b.streamId.startsWith(`${t.id}:`))) throw new HttpError(400, 'Bad streamId')
    if (t.type === 'series' && b.streamId === t.id) throw new HttpError(400, 'Series progress needs an episode streamId (tt…:season:episode)')
    const position = Number(b.position)
    const duration = Number(b.duration)
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0 || duration > 86_400 || position < 0) throw new HttpError(400, 'Bad position or duration')
    const from = typeof b.from === 'string' && /^[a-z]+(:[^\s]{1,200})?$/.test(b.from) ? b.from : undefined
    return { progress: store.recordProgress(p.id, { ...t, streamId: b.streamId, position, duration, from }) }
  })

  app.delete<TitleParams & { Querystring: { forget?: string } }>('/api/me/progress/:type/:id', async req => {
    const p = profileOf(req)
    const t = title(req.params)
    store.clearProgress(p.id, t, req.query.forget === '1' ? 'forget' : 'hide')
    return store.titleState(p.id, t)
  })

  app.put<TitleParams & { Body: DismissRequest }>('/api/me/dismiss/:type/:id', async req => {
    const p = profileOf(req)
    const t = title(req.params)
    const reason = req.body?.reason
    if (reason !== 'not_interested' && reason !== 'seen') throw new HttpError(400, "reason must be 'not_interested' or 'seen'")
    store.dismiss(p.id, t, reason)
    return store.titleState(p.id, t)
  })

  app.delete<TitleParams>('/api/me/dismiss/:type/:id', async req => {
    const p = profileOf(req)
    const t = title(req.params)
    store.dismiss(p.id, t, null)
    return store.titleState(p.id, t)
  })

  // ---- Recommendations -------------------------------------------------------------

  app.get<{ Querystring: { type?: string } }>('/api/me/home', async req => {
    const { type } = req.query
    return reco.home(profileOf(req), type === 'movie' || type === 'series' ? type : undefined, { record: !hasPrivateHeader(req) })
  })

  app.get<{ Querystring: { type?: string; from?: string } }>('/api/me/home/more', async req => {
    const { type, from } = req.query
    const n = Number(from)
    if (!Number.isInteger(n) || n < 0 || n > 200) throw new HttpError(400, 'from must be a row number')
    return reco.homeMore(profileOf(req), type === 'movie' || type === 'series' ? type : undefined, n, { record: !hasPrivateHeader(req) })
  })

  app.get<{ Querystring: { type?: string; id?: string; have?: string } }>('/api/me/row', async req => {
    const { type, id, have } = req.query
    if (typeof id !== 'string' || !/^[a-z]+(:[^\s]{1,200})?$/.test(id)) throw new HttpError(400, 'Bad row id')
    const ids = typeof have === 'string' && have ? have.split(',').filter(x => /^tt\d{1,10}$/.test(x)).slice(0, 400) : []
    return { items: reco.rowMore(profileOf(req), type === 'movie' || type === 'series' ? type : undefined, id, ids) }
  })

  app.get<TitleParams>('/api/title/:type/:id/similar', async req => ({
    items: await reco.similar(profileOf(req), title(req.params), 20, { cache: !hasPrivateHeader(req) }),
  }))

  app.get('/api/me/onboarding', async req => reco.onboarding(profileOf(req)))

  app.get('/api/me/taste', async req => reco.taste(profileOf(req)))

  app.put<{ Body: FeaturePrefRequest }>('/api/me/taste/feature', async req => {
    const p = profileOf(req)
    const { feature, value } = req.body ?? ({} as FeaturePrefRequest)
    if (typeof feature !== 'string' || !isTunableFeature(feature)) throw new HttpError(400, 'Unknown feature key')
    if (value !== 1 && value !== -1 && value !== 0) throw new HttpError(400, 'value must be 1, -1 or 0')
    store.setFeaturePref(p.id, feature, value)
    return reco.taste(p)
  })
}
