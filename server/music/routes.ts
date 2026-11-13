import { spawn } from 'node:child_process'
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MusicCastMode, MusicHome } from '../../shared/music.ts'
import { HttpError } from '../http.ts'
import { parseRange } from '../engine/range.ts'
import { isLoopback } from '../lan/net.ts'
import { hasPrivateHeader, refuseInPrivate } from '../private.ts'
import type { TasteStore } from '../store.ts'
import { profileFrom } from '../taste/routes.ts'
import { CastError } from '../cast/protocol.ts'
import { ALBUM_ID, ARTIST_ID, TRACK_ID } from './catalog.ts'
import type { MusicCast } from './cast.ts'
import { type MusicFiles, MusicFileError } from './files.ts'
import type { Lyrics } from './lyrics.ts'
import { lyricsAss, lyricsVideoArgs, prepareArt } from './render.ts'
import type { MusicService } from './service.ts'

// Music (docs/adr/0010):
//
//   GET  /api/music/home[?refresh=1]       MusicHome
//   GET  /api/music/search?q=              MusicSearchResponse
//   GET  /api/music/artist/:id             MusicArtistPage
//   GET  /api/music/album/:id              MusicAlbum
//   GET  /api/music/mix/:id                MusicMix ("liked" for liked songs)
//   GET  /api/music/starters               { artists }   popular artists for a first visit
//   POST /api/music/radio                  MusicRadioRequest → MusicRadioResponse
//   POST /api/music/ai                     { prompt? } → MusicMix
//   POST /api/music/rate                   MusicRateRequest
//   POST /api/music/listen                 MusicListen
//   GET  /api/music/track/:id              { track, rating }
//   GET  /api/music/lyrics/:id             MusicLyrics
//   POST /api/music/prefetch               { ids }
//   GET  /api/music/audio/:id              the song (audio/mp4, ranges), fetched first if needed
//   GET  /api/music/setup                  MusicSetup   (progress while it installs)
//   POST /api/music/setup                  MusicSetup   (on this computer only; starts it and answers at once)
//   GET  /api/music/cast                   MusicCastStatus
//   POST /api/music/cast                   MusicCastRequest → MusicCastStatus
//   POST /api/music/cast/control           { action, t?, index?, level?, muted?, mode? }
//   POST /api/music/cast/queue             { queue, index? }
//   POST /api/music/cast/stop
//   GET  /cast/m/:token/{audio.m4a,video.mp4,lyrics.mp4}   for the TV (token-checked, no cookie)

export interface MusicRouteDeps {
  music: MusicService
  files: MusicFiles
  lyrics: Lyrics
  cast: MusicCast
  tasteStore: TasteStore
  ffmpeg: string
  dataDir: string
}

const MODES: MusicCastMode[] = ['audio', 'lyrics', 'video']

/** A file on this computer, with HTTP Range (songs, and trailers in server/trailers.ts). */
export function sendFile (req: FastifyRequest, reply: FastifyReply, path: string, type: string, extra: Record<string, string> = {}) {
  const size = statSync(path).size
  const range = parseRange(req.headers.range, size)
  if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send()
  const { start, end } = range ?? { start: 0, end: size - 1 }
  reply.code(range ? 206 : 200).headers({
    'accept-ranges': 'bytes',
    'content-type': type,
    'content-length': String(end - start + 1),
    'cache-control': 'private, max-age=3600',
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    ...extra,
  })
  if (req.method === 'HEAD') return reply.send()
  return reply.send(createReadStream(path, { start, end }))
}

export function registerMusicRoutes (app: FastifyInstance, d: MusicRouteDeps): void {
  const { music } = d
  const local = (req: FastifyRequest) => isLoopback(req.socket.remoteAddress)
  const profile = (req: FastifyRequest) => profileFrom(d.tasteStore, req)
  const guard = (req: FastifyRequest) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Not allowed from another site')
    return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  }
  const id = (v: string, re: RegExp, what: string) => { if (!re.test(v)) throw new HttpError(400, `Bad ${what} id`); return v }
  const ids = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && TRACK_ID.test(x)).slice(0, max) : [])
  const castRun = async <T>(fn: () => Promise<T> | T) => {
    try { return await fn() } catch (err) {
      if (!(err instanceof CastError)) throw err
      const status = ({ unknown_device: 404, no_network: 409, not_casting: 409, no_media: 409, timeout: 504 } as Record<string, number>)[err.code] ?? 502
      throw new HttpError(status, err.message)
    }
  }

  app.get<{ Querystring: { refresh?: string } }>('/api/music/home', async (req): Promise<MusicHome> =>
    music.home(profile(req), { local: local(req), refresh: req.query.refresh === '1' }))

  app.get<{ Querystring: { q?: string } }>('/api/music/search', async req => {
    const q = (req.query.q ?? '').trim()
    if (q.length < 2) return { tracks: [], artists: [], albums: [] }
    return music.search(q.slice(0, 100))
  })

  app.get<{ Params: { id: string } }>('/api/music/artist/:id', async req => music.artist(profile(req), id(req.params.id, ARTIST_ID, 'artist')))
  app.get<{ Params: { id: string } }>('/api/music/album/:id', async req => music.album(id(req.params.id, ALBUM_ID, 'album')))
  app.get<{ Params: { id: string } }>('/api/music/mix/:id', async req => {
    if (req.params.id !== 'liked' && !/^m[0-9a-f]{15}$/.test(req.params.id)) throw new HttpError(400, 'Bad mix id')
    return music.mix(profile(req), req.params.id)
  })
  app.get('/api/music/starters', async () => ({ artists: await music.starters() }))

  app.post('/api/music/radio', async req => {
    const b = guard(req)
    return music.radio(profile(req), {
      track: typeof b.track === 'string' && TRACK_ID.test(b.track) ? b.track : undefined,
      artist: typeof b.artist === 'string' && ARTIST_ID.test(b.artist) ? b.artist : undefined,
      mood: typeof b.mood === 'string' && b.mood.trim() ? b.mood.trim().slice(0, 80) : undefined,
      exclude: ids(b.exclude, 1000),
    }, { keep: !hasPrivateHeader(req) })
  })

  app.post('/api/music/ai', async req => {
    const b = guard(req)
    refuseInPrivate(req, 'make AI mixes')
    return music.aiMix(profile(req), typeof b.prompt === 'string' ? b.prompt.slice(0, 300) : undefined)
  })

  app.post('/api/music/rate', async (req, reply) => {
    const b = guard(req)
    refuseInPrivate(req, 'like songs')
    const kind = b.kind === 'artist' ? 'artist' : b.kind === 'track' ? 'track' : null
    if (!kind || typeof b.id !== 'string' || !(kind === 'artist' ? ARTIST_ID : TRACK_ID).test(b.id)) throw new HttpError(400, 'kind and id are required')
    if (b.rating !== 1 && b.rating !== -1 && b.rating !== 0) throw new HttpError(400, 'rating must be 1, -1 or 0')
    music.rate(profile(req), kind, b.id, b.rating)
    return reply.code(204).send()
  })

  app.post('/api/music/listen', async (req, reply) => {
    const b = guard(req)
    if (hasPrivateHeader(req)) return reply.code(204).send()
    if (typeof b.trackId !== 'string' || !TRACK_ID.test(b.trackId)) throw new HttpError(400, 'trackId is required')
    const played = typeof b.played === 'number' && Number.isFinite(b.played) ? Math.max(0, Math.min(b.played, 7200)) : 0
    const how = b.how === 'ended' || b.how === 'skipped' ? b.how : 'left'
    music.listen(profile(req), b.trackId, played, how)
    return reply.code(204).send()
  })

  app.get<{ Params: { id: string } }>('/api/music/track/:id', async req => {
    const t = music.track(id(req.params.id, TRACK_ID, 'song'))
    return { track: t, rating: music.rating(profile(req), t.id) }
  })

  app.get<{ Params: { id: string } }>('/api/music/lyrics/:id', async req => music.lyrics(id(req.params.id, TRACK_ID, 'song')))

  app.post('/api/music/prefetch', async (req, reply) => {
    const b = guard(req)
    music.prefetch(ids(b.ids, 2))
    return reply.code(204).send()
  })

  const audio = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const t = music.track(id(req.params.id, TRACK_ID, 'song'))
    if (!music.setup(false).ready) throw new HttpError(409, 'Set up music on the computer first.')
    const path = await d.files.ensure(t, 'audio').catch(err => {
      throw new HttpError(err instanceof MusicFileError ? err.status : 502, (err as Error).message)
    })
    return sendFile(req, reply, path, 'audio/mp4')
  }
  app.get('/api/music/audio/:id', audio)
  app.head('/api/music/audio/:id', audio)

  app.get('/api/music/setup', async req => music.setup(local(req)))
  app.post('/api/music/setup', async req => {
    guard(req)
    if (!local(req)) throw new HttpError(403, 'Set up music on the computer that runs nexttupp.')
    return music.install()
  })

  // ---- Casting ----

  app.get('/api/music/cast', async () => d.cast.status())

  app.post('/api/music/cast', async req => {
    const b = guard(req)
    if (typeof b.deviceId !== 'string' || !b.deviceId || b.deviceId.length > 200) throw new HttpError(400, 'deviceId is required')
    const queue = ids(b.queue, 500)
    const index = Number.isInteger(b.index) ? b.index as number : 0
    if (!queue.length || index < 0 || index >= queue.length) throw new HttpError(400, 'queue and index are required')
    const mode = MODES.includes(b.mode as MusicCastMode) ? b.mode as MusicCastMode : 'audio'
    const t = typeof b.t === 'number' && Number.isFinite(b.t) ? Math.max(0, b.t) : 0
    return castRun(() => d.cast.start({ deviceId: b.deviceId as string, queue, index, t, mode }))
  })

  app.post('/api/music/cast/control', async req => {
    const b = guard(req)
    const action = String(b.action ?? '')
    if (!['play', 'pause', 'next', 'prev', 'seek', 'jump', 'volume', 'mode'].includes(action)) throw new HttpError(400, 'Unknown action')
    if (action === 'pause' || action === 'play') req.log.info(`music cast: ${action} asked by ${req.socket.remoteAddress}${b.why ? ` (${String(b.why).slice(0, 20)})` : ''}`)
    return castRun(() => d.cast.control(action, {
      t: typeof b.t === 'number' && Number.isFinite(b.t) ? b.t : undefined,
      index: Number.isInteger(b.index) ? b.index as number : undefined,
      level: typeof b.level === 'number' && b.level >= 0 && b.level <= 1 ? b.level : undefined,
      muted: typeof b.muted === 'boolean' ? b.muted : undefined,
      mode: MODES.includes(b.mode as MusicCastMode) ? b.mode as MusicCastMode : undefined,
    }))
  })

  app.post('/api/music/cast/queue', async req => {
    const b = guard(req)
    return castRun(() => d.cast.setQueue(ids(b.queue, 500), Number.isInteger(b.index) ? b.index as number : undefined))
  })

  app.post('/api/music/cast/stop', async req => {
    guard(req)
    req.log.info(`music cast: stop asked by ${req.socket.remoteAddress} (${String(req.headers['user-agent'] ?? '').slice(0, 80)})`)
    return d.cast.stop()
  })

  // ---- What the TV fetches ----

  const grant = (req: FastifyRequest<{ Params: { token: string } }>, mode: MusicCastMode) => {
    const g = d.cast.verify(req.params.token, req.socket.remoteAddress)
    if (!g || g.mode !== mode) throw new HttpError(404, 'Not found')
    return g
  }
  const CORS = { 'access-control-allow-origin': '*' }

  for (const [file, kind, type] of [['audio.m4a', 'audio', 'audio/mp4'], ['video.mp4', 'video', 'video/mp4']] as const) {
    const handler = async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const g = grant(req, kind)
      const saved = d.files.saved(g.trackId, kind)
      if (!saved) throw new HttpError(404, 'Not found')
      return sendFile(req, reply, saved.path, type, CORS)
    }
    app.get(`/cast/m/:token/${file}`, handler)
    app.head(`/cast/m/:token/${file}`, handler)
  }

  app.get<{ Params: { token: string } }>('/cast/m/:token/lyrics.mp4', async (req, reply) => {
    const g = grant(req, 'lyrics')
    const t = music.track(g.trackId)
    const saved = d.files.saved(t.id, 'audio')
    if (!saved) throw new HttpError(404, 'Not found')
    const duration = saved.duration ?? t.duration
    const [words, art] = await Promise.all([
      d.lyrics.for(t).catch(() => ({ synced: null, plain: null, instrumental: false })),
      prepareArt(d.ffmpeg, join(d.dataDir, 'music', 'art'), t),
    ])
    const work = join(d.dataDir, 'music', 'render', req.params.token.slice(0, 16) + Date.now().toString(36))
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'lyrics.ass'), lyricsAss({ lines: words.synced, title: t.title, artist: t.credit ?? t.artist.name, duration, from: g.from }))
    const proc = spawn(d.ffmpeg, lyricsVideoArgs({ bg: art.bg, art: art.art, audio: saved.path, from: g.from, length: duration - g.from }), { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', c => { stderr = (stderr + c).slice(-1500) })
    proc.on('close', code => {
      rmSync(work, { recursive: true, force: true })
      if (code && code !== 255 && !reply.raw.destroyed) req.log.warn({ code, stderr: stderr.trim() }, 'lyrics picture: ffmpeg exited')
    })
    reply.raw.on('close', () => proc.kill('SIGKILL'))
    return reply.headers({ ...CORS, 'content-type': 'video/mp4', 'cache-control': 'no-store' }).send(proc.stdout)
  })
}
