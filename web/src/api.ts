import { isPrivate } from './private.ts'
import type {
  AiPicksResponse, AiProvider, AiSearchResponse, AiSettingsRequest, AiSignInResponse, AiStatus,
  ClientCaps, CreateProfileRequest, DismissReason, FeaturePrefRequest, HealthResponse, HomeMoreResponse, HomeResponse, MediaType, OnboardingResponse,
  OpenSessionRequest, ProbeResponse, Profile, ProgressRequest, ProgressResponse, Rating, RecItem, RowMoreResponse, SessionStats, SimilarResponse,
  SourcesResponse, TasteSummary, TitleDetail, TitleMarks, TitleState, TitleSummary, UpdateProfileRequest,
} from '../../shared/types.ts'

export interface Stats extends SessionStats { ranges: Array<[number, number]> }
export interface SubtitleOption { id: string; lang: string; label: string; release?: string; url: string; match: number }
export interface Cue { start: number; end: number; text: string }
export interface LibraryItem {
  id: string; infoHash: string; fileIdx: number; fileName: string; title: string
  type: MediaType; imdbId: string; streamId: string; addedAt: number
  stats: Stats | null
  /** Saved from the source list and still waiting for the torrent's metadata from peers. */
  pending?: boolean
  swarm?: { peers: number; downloadSpeed: number } | null
}
export interface DownloadRequest {
  infoHash: string; fileIdx?: number; fileName?: string; trackers?: string[]
  type: MediaType; imdbId: string; streamId: string; title: string
}

// Account and sync (optional). The local server holds the session; the browser sees only this.
export type SyncState = 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
export interface AccountStatus {
  signedIn: boolean
  cloudUrl: string
  account?: { email: string; displayName: string | null; role: 'admin' | 'member' }
  sync?: { state: SyncState; lastSyncAt: number | null; error: string | null; pending: number; retryAt: number | null }
  /** Why this computer was signed out, when it wasn't the person's doing. */
  notice?: string
  /** After sign-in: local profile → the account's profile it was merged into. */
  merged?: Record<string, string>
}
// Phones and TVs on the home Wi-Fi (server/lan). Settings change only on the computer itself (`local`).
export interface LanClient { id: string; label: string; createdAt: number; lastUsedAt: number; current: boolean }
export interface LanStatus {
  local: boolean; signedIn: boolean; enabled: boolean; phonesEnabled: boolean; listening: boolean
  name: string; defaultName: string; urls: string[]; clients: LanClient[]
}

// Casting to a TV (server/cast). The computer talks to the TV; any page of the app can follow and control it.
export interface CastDevice { id: string; name: string; model: string }
export type CastState = 'connecting' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'stopped' | 'error'
export interface CastStatus {
  active: boolean
  device?: { id: string; name: string }
  sessionId?: string
  title?: string
  streamId?: string
  state?: CastState
  position?: number
  duration?: number
  volume?: number | null
  muted?: boolean
  mode?: 'direct' | 'remux' | 'transcode'
  error?: string
  /** Subtitle size on the TV, times its own. */
  subtitleScale?: number
  /** The subtitle showing on the TV (its URL), or null for none. */
  subtitle?: string | null
  /** The file playing: after the computer went on to the next episode, the page opens it. */
  source?: CastSource
  /** The episode the computer plays when this one ends ("Show · S1E3 Name"). */
  upNext?: { streamId: string; name: string }
  /** The connection to the TV dropped; the computer is joining its player again. */
  reconnecting?: boolean
}
export interface CastSubtitle { url: string; lang?: string; label?: string; offset?: number }
export interface CastSource { infoHash: string; fileIdx?: number; fileName?: string; type: MediaType; imdbId: string }
export interface CastStartRequest {
  deviceId: string; sessionId: string; t: number; audio?: number
  /** The subtitle showing from the start, and every one the viewer can switch to (tracks on the TV). */
  subtitle?: CastSubtitle | null
  subtitles?: CastSubtitle[]
  /** The player's subtitle size (A−/A+). */
  subtitleScale?: number
  title?: string; streamId?: string; image?: string
  /** With it, the computer saves this profile's progress and plays the next episode on the TV. */
  source?: CastSource
  /** Where the title was opened from, kept with the progress. */
  from?: string
}
/** "subtitle" switches the TV's subtitle in place (null: off); `subtitles` is the player's list again. */
export type CastControl =
  | { action: 'play' | 'pause' }
  | { action: 'seek'; t: number }
  | { action: 'volume'; level?: number; muted?: boolean }
  | { action: 'subtitle'; subtitle: CastSubtitle | null; subtitles?: CastSubtitle[] }
  | { action: 'subtitleSize'; scale: number }
  /** Whether the next episode follows on the TV ("Not now": false), or play it now. */
  | { action: 'upNext'; on: boolean }
  | { action: 'next' }

export class ApiError extends Error {
  readonly status: number
  constructor (message: string, status: number) {
    super(message)
    this.status = status
  }
}

// ---- Active profile ("who's watching") ------------------------------------------------
// Sent with every request as `x-nexttupp-profile`. Without one the server uses the first profile.

const PROFILE_KEY = 'nexttupp:profile'
let activeProfile: string | null = (() => { try { return localStorage.getItem(PROFILE_KEY) } catch { return null } })()

export const getActiveProfile = (): string | null => activeProfile
export function setActiveProfile (id: string | null): void {
  activeProfile = id
  try { if (id) localStorage.setItem(PROFILE_KEY, id); else localStorage.removeItem(PROFILE_KEY) } catch { /* storage unavailable */ }
}

// A 404 from a profile-scoped route means the active profile was deleted (on another device, say).
const goneListeners = new Set<() => void>()
/** Called when the server says the active profile no longer exists. Returns an unsubscribe function. */
export function onProfileGone (fn: () => void): () => void {
  goneListeners.add(fn)
  return () => { goneListeners.delete(fn) }
}
/** Image fields in API responses. In private mode they load through the server's uncached relay (/api/img). */
const IMAGE_KEYS = new Set(['poster', 'background', 'logo', 'thumbnail'])

function relayImages (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relayImages)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = IMAGE_KEYS.has(k) && typeof v === 'string' && v.startsWith('https://') ? imageUrl(v) : relayImages(v)
  }
  return out
}

/** An image URL as it should load now: through the uncached relay in private mode. */
export const imageUrl = (url: string): string =>
  isPrivate() && url.startsWith('https://') ? `/api/img?u=${encodeURIComponent(url)}` : url

const profileScoped = (path: string) => path.startsWith('/api/me') || /^\/api\/title\/[^/]+\/[^/]+\/similar/.test(path)

async function req<T> (path: string, init?: RequestInit): Promise<T> {
  let res: Response
  const sentProfile = activeProfile
  try {
    const headers = new Headers(init?.headers)
    if (sentProfile) headers.set('x-nexttupp-profile', sentProfile)
    if (isPrivate()) headers.set('x-nexttupp-private', '1')
    res = await fetch(path, { ...init, headers, ...(isPrivate() ? { cache: 'no-store' as const } : {}) })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError('Can’t reach nexttupp on this computer. Is it running?', 0)
  }
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 404 && sentProfile && sentProfile === activeProfile && profileScoped(path)) goneListeners.forEach(fn => fn())
    throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status)
  }
  return (isPrivate() ? relayImages(body) : body) as T
}

/**
 * Progress sent while the page is going away (leaving the player, closing the tab). `keepalive` lets the
 * request outlive the page; sendBeacon can't carry the profile header. Failures are ignored.
 */
function sendProgressOnExit (body: ProgressRequest): void {
  if (isPrivate()) return
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (activeProfile) headers['x-nexttupp-profile'] = activeProfile
  try {
    fetch('/api/me/progress', { method: 'POST', headers, body: JSON.stringify(body), keepalive: true }).catch(() => {})
  } catch { /* keepalive quota exceeded or fetch unavailable */ }
}

const t = (type: MediaType, id: string) => `${type}/${id}`

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
})

const titles = new Map<string, { at: number; job: Promise<TitleDetail> }>()
const TITLE_TTL = 30 * 60_000

export const capsParam = (caps: ClientCaps) => Object.entries(caps).filter(([, v]) => v).map(([k]) => k).join(',')

export const api = {
  search: (q: string, signal?: AbortSignal) => req<TitleSummary[]>(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
  popular: (type: MediaType) => req<TitleSummary[]>(`/api/popular/${type}`),
  /** A title's details. Kept for a while, so the popup, a hover, and then the title page fetch them once. */
  title: (type: MediaType, id: string): Promise<TitleDetail> => {
    const key = `${type}/${id}/${isPrivate() ? 'p' : ''}`
    const hit = titles.get(key)
    if (hit && Date.now() - hit.at < TITLE_TTL) return hit.job
    const job = req<TitleDetail>(`/api/title/${type}/${id}`)
    titles.delete(key)
    titles.set(key, { at: Date.now(), job })
    if (titles.size > 60) titles.delete(titles.keys().next().value!)
    job.catch(() => { if (titles.get(key)?.job === job) titles.delete(key) })
    return job
  },
  /** More YouTube trailers for a title, found by searching (when Cinemeta's are missing or don't play). */
  trailerSearch: (type: MediaType, id: string) => req<{ ids: string[] }>(`/api/trailer/${type}/${id}/search`),
  sources: (type: MediaType, streamId: string) => req<SourcesResponse>(`/api/sources/${type}/${encodeURIComponent(streamId)}`),
  swarm: (hashes: string[]) => req<HealthResponse>(`/api/swarm?h=${hashes.join(',')}`),
  open: (body: OpenSessionRequest) => req<Stats>('/api/sessions', json('POST', body)),
  sessions: () => req<Stats[]>('/api/sessions'),
  stats: (id: string) => req<Stats>(`/api/sessions/${id}`),
  probe: (id: string, caps: ClientCaps, audio?: number) =>
    req<ProbeResponse>(`/api/sessions/${id}/probe?caps=${capsParam(caps)}${audio !== undefined ? `&audio=${audio}` : ''}`),
  streamStart: (id: string, t: number) => req<{ start: number; exact: boolean }>(`/api/sessions/${id}/stream-start?t=${t.toFixed(2)}`),
  library: () => req<LibraryItem[]>('/api/library'),
  keep: (body: { sessionId: string; type: MediaType; imdbId: string; streamId: string; title: string }) => req<Stats>('/api/library', json('POST', body)),
  /** Keep a source without playing it; the server keeps asking peers until it can start. */
  download: (body: DownloadRequest) => req<LibraryItem>('/api/library', json('POST', body)),
  unkeep: (id: string, deleteFiles: boolean) => req<void>(`/api/library/${id}${deleteFiles ? '?deleteFiles=1' : ''}`, json('DELETE')),
  subtitles: (type: MediaType, streamId: string, fileName?: string) =>
    req<SubtitleOption[]>(`/api/subtitles/${type}/${encodeURIComponent(streamId)}${fileName ? `?file=${encodeURIComponent(fileName)}` : ''}`),
  cues: (url: string) => req<Cue[]>(`/api/subtitle-cues?url=${encodeURIComponent(url)}`),

  // Profiles. A 404 from any /api/me route means the active profile was deleted: pick again.
  profiles: () => req<Profile[]>('/api/profiles'),
  createProfile: (body: CreateProfileRequest) => req<Profile>('/api/profiles', json('POST', body)),
  updateProfile: (id: string, body: UpdateProfileRequest) => req<Profile>(`/api/profiles/${id}`, json('PATCH', body)),
  deleteProfile: (id: string) => req<void>(`/api/profiles/${id}`, json('DELETE')),
  me: () => req<{ profile: Profile }>('/api/me'),

  // Taste state for one title.
  titleState: (type: MediaType, id: string) => req<TitleState>(`/api/me/state/${t(type, id)}`),
  /** Every rating and My List entry, for the buttons under each poster. */
  marks: () => req<TitleMarks>('/api/me/marks'),
  rate: (type: MediaType, id: string, value: Rating, source?: string) => req<TitleState>(`/api/me/rating/${t(type, id)}`, json('PUT', { value, source })),
  myList: () => req<RecItem[]>('/api/me/list'),
  addToList: (type: MediaType, id: string) => req<TitleState>(`/api/me/list/${t(type, id)}`, json('PUT')),
  removeFromList: (type: MediaType, id: string) => req<TitleState>(`/api/me/list/${t(type, id)}`, json('DELETE')),
  /** The player calls this every ~10 s while playing and on pause/exit. */
  progress: (body: ProgressRequest) => req<ProgressResponse>('/api/me/progress', json('POST', body)),
  /** The same, for the last report as the player closes: survives navigation and tab close. */
  progressOnExit: sendProgressOnExit,
  /** Remove from Continue watching; `forget` also drops it from taste ("that wasn't me"). */
  clearProgress: (type: MediaType, id: string, forget = false) => req<TitleState>(`/api/me/progress/${t(type, id)}${forget ? '?forget=1' : ''}`, json('DELETE')),
  dismiss: (type: MediaType, id: string, reason: DismissReason) => req<TitleState>(`/api/me/dismiss/${t(type, id)}`, json('PUT', { reason })),
  undismiss: (type: MediaType, id: string) => req<TitleState>(`/api/me/dismiss/${t(type, id)}`, json('DELETE')),

  // Account and sync. Every write sends a JSON body (the server requires one).
  account: () => req<AccountStatus>('/api/account'),
  login: (email: string, password: string) => req<AccountStatus>('/api/account/login', json('POST', { email, password })),
  signup: (body: { email: string; password: string; displayName?: string }) => req<AccountStatus>('/api/account/signup', json('POST', body)),
  logout: () => req<AccountStatus>('/api/account/logout', json('POST', {})),
  syncNow: () => req<AccountStatus>('/api/account/sync', json('POST', {})),
  castDevices: (refresh = false) => req<{ devices: CastDevice[] }>(`/api/cast/devices${refresh ? '?refresh=1' : ''}`),
  cast: () => req<CastStatus>('/api/cast'),
  castStart: (body: CastStartRequest) => req<CastStatus>('/api/cast', json('POST', body)),
  castControl: (body: CastControl) => req<CastStatus>('/api/cast/control', json('POST', body)),
  castStop: () => req<CastStatus>('/api/cast/stop', json('POST', {})),
  lan: () => req<LanStatus>('/api/lan'),
  setLan: (body: { enabled?: boolean; name?: string }) => req<LanStatus>('/api/lan', json('PATCH', body)),
  removeLanClient: (id: string) => req<void>(`/api/lan/clients/${id}`, json('DELETE')),

  // Recommendations.
  home: (type?: MediaType) => req<HomeResponse>(`/api/me/home${type ? `?type=${type}` : ''}`),
  /** The home rows below the first `from`, a few at a time, as the viewer scrolls down. */
  homeMore: (from: number, type?: MediaType) => req<HomeMoreResponse>(`/api/me/home/more?from=${from}${type ? `&type=${type}` : ''}`),
  /** More titles for a row scrolled to its end, skipping the ones it has. */
  rowMore: (id: string, have: string[], type?: MediaType) =>
    req<RowMoreResponse>(`/api/me/row?id=${encodeURIComponent(id)}&have=${have.join(',')}${type ? `&type=${type}` : ''}`).then(r => r.items),
  similar: (type: MediaType, id: string) => req<SimilarResponse>(`/api/title/${t(type, id)}/similar`),
  onboarding: () => req<OnboardingResponse>('/api/me/onboarding'),
  taste: () => req<TasteSummary>('/api/me/taste'),
  /** Boost (1), block (-1) or reset (0) a taste feature by its key from TasteSummary. */
  setFeaturePref: (feature: string, value: FeaturePrefRequest['value']) => req<TasteSummary>('/api/me/taste/feature', json('PUT', { feature, value })),
  // AI (optional). Only the POSTs below ask a model; everything else reads what is saved.
  ai: () => req<AiStatus>('/api/ai'),
  aiKey: (provider: 'anthropic' | 'openai', key: string) => req<AiStatus>('/api/ai/key', json('PUT', { provider, key })),
  aiSettings: (body: AiSettingsRequest) => req<AiStatus>('/api/ai', json('PATCH', body)),
  aiChatgpt: () => req<AiSignInResponse>('/api/ai/chatgpt', json('POST', {})),
  aiDisconnect: (provider: AiProvider) => req<AiStatus & { revoked?: boolean }>(`/api/ai/${provider}`, json('DELETE')),
  aiPicks: () => req<AiPicksResponse>('/api/ai/picks'),
  makeAiPicks: () => req<AiPicksResponse>('/api/ai/picks', json('POST', {})),
  aiSearch: (q: string, refresh = false) => req<AiSearchResponse>('/api/ai/search', json('POST', { q, refresh })),
}

/** For other API modules (music): the same profile, private-mode and error handling. */
export { req as request }
