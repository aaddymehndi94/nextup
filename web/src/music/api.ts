import type {
  MusicAlbum, MusicArtist, MusicArtistPage, MusicCastMode, MusicCastStatus, MusicHome, MusicLyrics, MusicMix, MusicRadioRequest,
  MusicRadioResponse, MusicSearchResponse, MusicSetup, MusicTrack,
} from '../../../shared/music.ts'
import { request as req } from '../api.ts'

const post = <T>(path: string, body: unknown = {}) =>
  req<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const musicApi = {
  home: (refresh = false) => req<MusicHome>(`/api/music/home${refresh ? '?refresh=1' : ''}`),
  search: (q: string, signal?: AbortSignal) => req<MusicSearchResponse>(`/api/music/search?q=${encodeURIComponent(q)}`, { signal }),
  artist: (id: string) => req<MusicArtistPage>(`/api/music/artist/${id}`),
  album: (id: string) => req<MusicAlbum>(`/api/music/album/${id}`),
  mix: (id: string) => req<MusicMix>(`/api/music/mix/${id}`),
  starters: () => req<{ artists: MusicArtist[] }>('/api/music/starters'),
  radio: (r: MusicRadioRequest) => post<MusicRadioResponse>('/api/music/radio', r),
  aiMix: (prompt?: string) => post<MusicMix>('/api/music/ai', { prompt }),
  rate: (kind: 'track' | 'artist', id: string, rating: 1 | -1 | 0) => post<void>('/api/music/rate', { kind, id, rating }),
  listen: (trackId: string, played: number, how: 'ended' | 'skipped' | 'left') => post<void>('/api/music/listen', { trackId, played, how }),
  track: (id: string) => req<{ track: MusicTrack; rating: 1 | -1 | 0 }>(`/api/music/track/${id}`),
  lyrics: (id: string) => req<MusicLyrics>(`/api/music/lyrics/${id}`),
  prefetch: (ids: string[]) => post<void>('/api/music/prefetch', { ids }),
  setup: () => post<MusicSetup>('/api/music/setup'),
  setupStatus: () => req<MusicSetup>('/api/music/setup'),
  cast: () => req<MusicCastStatus>('/api/music/cast'),
  castStart: (b: { deviceId: string; queue: string[]; index: number; t: number; mode: MusicCastMode }) => post<MusicCastStatus>('/api/music/cast', b),
  castControl: (b: { action: string; t?: number; index?: number; level?: number; muted?: boolean; mode?: MusicCastMode; why?: string }) => post<MusicCastStatus>('/api/music/cast/control', b),
  castQueue: (queue: string[], index?: number) => post<MusicCastStatus>('/api/music/cast/queue', { queue, index }),
  castStop: () => post<MusicCastStatus>('/api/music/cast/stop'),
}

export const audioUrl = (id: string) => `/api/music/audio/${id}`
