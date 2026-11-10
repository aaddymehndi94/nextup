import type {
  ClientCaps, HealthResponse, MediaType, OpenSessionRequest, ProbeResponse, SessionStats, SourcesResponse,
  TitleDetail, TitleSummary,
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

async function req<T> (path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError('Cannot reach the nextup server. Is it running?', 0)
  }
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status)
  return body as T
}

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
}
