import type {
  ClientCaps, CreateProfileRequest, DismissReason, FeaturePrefRequest, HealthResponse, HomeResponse, MediaType, OnboardingResponse,
  OpenSessionRequest, ProbeResponse, Profile, ProgressRequest, ProgressResponse, Rating, RecItem, SessionStats, SimilarResponse,
  SourcesResponse, TasteSummary, TitleDetail, TitleState, TitleSummary, UpdateProfileRequest,
} from '../../shared/types.ts'

export interface Stats extends SessionStats { ranges: Array<[number, number]> }
export interface SubtitleOption { id: string; lang: string; label: string; release?: string; url: string; match: number }
export interface Cue { start: number; end: number; text: string }
export interface LibraryItem {
  id: string; infoHash: string; fileIdx: number; fileName: string; title: string
  type: MediaType; imdbId: string; streamId: string; addedAt: number
  stats: Stats | null
}

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

async function req<T> (path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    const headers = new Headers(init?.headers)
    if (activeProfile) headers.set('x-nexttupp-profile', activeProfile)
    res = await fetch(path, { ...init, headers })
  } catch {
    throw new ApiError('Can’t reach nexttupp on this computer. Is it running?', 0)
  }
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status)
  return body as T
}

const t = (type: MediaType, id: string) => `${type}/${id}`

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
})

export const capsParam = (caps: ClientCaps) => Object.entries(caps).filter(([, v]) => v).map(([k]) => k).join(',')

export const api = {
  search: (q: string, signal?: AbortSignal) => req<TitleSummary[]>(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
  popular: (type: MediaType) => req<TitleSummary[]>(`/api/popular/${type}`),
  title: (type: MediaType, id: string) => req<TitleDetail>(`/api/title/${type}/${id}`),
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
  rate: (type: MediaType, id: string, value: Rating, source?: string) => req<TitleState>(`/api/me/rating/${t(type, id)}`, json('PUT', { value, source })),
  myList: () => req<RecItem[]>('/api/me/list'),
  addToList: (type: MediaType, id: string) => req<TitleState>(`/api/me/list/${t(type, id)}`, json('PUT')),
  removeFromList: (type: MediaType, id: string) => req<TitleState>(`/api/me/list/${t(type, id)}`, json('DELETE')),
  /** The player calls this every ~10 s while playing and on pause/exit. */
  progress: (body: ProgressRequest) => req<ProgressResponse>('/api/me/progress', json('POST', body)),
  /** Remove from Continue watching; `forget` also drops it from taste ("that wasn't me"). */
  clearProgress: (type: MediaType, id: string, forget = false) => req<TitleState>(`/api/me/progress/${t(type, id)}${forget ? '?forget=1' : ''}`, json('DELETE')),
  dismiss: (type: MediaType, id: string, reason: DismissReason) => req<TitleState>(`/api/me/dismiss/${t(type, id)}`, json('PUT', { reason })),
  undismiss: (type: MediaType, id: string) => req<TitleState>(`/api/me/dismiss/${t(type, id)}`, json('DELETE')),

  // Recommendations.
  home: () => req<HomeResponse>('/api/me/home'),
  similar: (type: MediaType, id: string) => req<SimilarResponse>(`/api/title/${t(type, id)}/similar`),
  onboarding: () => req<OnboardingResponse>('/api/me/onboarding'),
  taste: () => req<TasteSummary>('/api/me/taste'),
  /** Boost (1), block (-1) or reset (0) a taste feature by its key from TasteSummary. */
  setFeaturePref: (feature: string, value: FeaturePrefRequest['value']) => req<TasteSummary>('/api/me/taste/feature', json('PUT', { feature, value })),
}
