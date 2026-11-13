import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError } from '../http.ts'
import { isAllowedSubtitleUrl } from '../subtitles.ts'
import { CastError } from './protocol.ts'
import { MAX_TEXT_TRACKS, type CastService, type CastSubtitle } from './service.ts'

// Casting from the player, on this computer or a connected phone:
//
//   GET  /api/cast/devices[?refresh=1]   { devices: [{ id, name, model }] }   (refresh: ask the network, ~2.5 s)
//   GET  /api/cast                       CastStatus
//   POST /api/cast                       { deviceId, sessionId, t, audio?, subtitle?, subtitles?, title?, streamId?, image? } → CastStatus
//   POST /api/cast/control               { action: "play"|"pause"|"seek"|"volume"|"subtitle", t?, level?, muted?, subtitle?, subtitles? } → CastStatus
//
// subtitle is { url, label?, lang?, offset? } or null (none); subtitles is every one the viewer can pick, which
// the TV gets as tracks so a change of subtitle switches tracks there instead of reloading the film.
//   POST /api/cast/stop                  {} → the last CastStatus (where it was), then nothing is casting

const SESSION_ID = /^[0-9a-f]{40}-\d{1,6}$/

/** A subtitle from the player: only from the subtitle CDN (the server fetches it), or nothing. */
function parseSubtitle (v: unknown): CastSubtitle | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (typeof s.url !== 'string' || !isAllowedSubtitleUrl(s.url)) throw new HttpError(400, 'Subtitle URL not allowed')
  return {
    url: s.url,
    label: typeof s.label === 'string' ? s.label.slice(0, 60) : undefined,
    lang: typeof s.lang === 'string' && /^[a-z]{2,3}$/.test(s.lang) ? s.lang : undefined,
    offset: typeof s.offset === 'number' && Math.abs(s.offset) <= 600 ? s.offset : 0,
  }
}

/** The player's list of subtitles; entries that aren't allowed are left out. */
function parseSubtitles (v: unknown): CastSubtitle[] {
  if (!Array.isArray(v)) return []
  const out: CastSubtitle[] = []
  for (const item of v.slice(0, MAX_TEXT_TRACKS)) {
    try { const s = parseSubtitle(item); if (s) out.push({ ...s, offset: 0 }) } catch { /* not from the subtitle CDN */ }
  }
  return out
}

function toHttp (err: unknown): Error {
  if (!(err instanceof CastError)) return err as Error
  const status = ({ unknown_device: 404, no_network: 409, not_casting: 409, invalid: 409, no_media: 409, timeout: 504 } as Record<string, number>)[err.code] ?? 502
  return new HttpError(status, err.message)
}

export function registerCastRoutes (app: FastifyInstance, cast: CastService): void {
  // A JSON body means another website can't send these without a CORS preflight, which fails.
  const guard = (req: FastifyRequest) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Not allowed from another site')
    return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  }
  const run = async <T>(fn: () => Promise<T>) => { try { return await fn() } catch (err) { throw toHttp(err) } }

  app.get<{ Querystring: { refresh?: string } }>('/api/cast/devices', async req => {
    const devices = await cast.devices(req.query.refresh === '1')
    return { devices: devices.map(d => ({ id: d.id, name: d.name, model: d.model })) }
  })

  app.get('/api/cast', async () => cast.status())

  app.post('/api/cast', async req => {
    const b = guard(req)
    if (typeof b.deviceId !== 'string' || !b.deviceId || b.deviceId.length > 200) throw new HttpError(400, 'deviceId is required')
    if (typeof b.sessionId !== 'string' || !SESSION_ID.test(b.sessionId)) throw new HttpError(400, 'sessionId is required')
    const t = typeof b.t === 'number' && Number.isFinite(b.t) ? Math.max(0, b.t) : 0
    const audio = Number.isInteger(b.audio) && (b.audio as number) >= 0 && (b.audio as number) < 100 ? b.audio as number : undefined
    const subtitle = parseSubtitle(b.subtitle)
    const subtitles = parseSubtitles(b.subtitles)
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
    const image = typeof b.image === 'string' && /^https:\/\/[^\s"<>]{1,500}$/.test(b.image) ? b.image : undefined
    return run(() => cast.start({ deviceId: b.deviceId as string, sessionId: b.sessionId as string, t, audio, subtitle, subtitles, title: text(b.title, 200), streamId: text(b.streamId, 40), image }))
  })

  app.post('/api/cast/control', async req => {
    const b = guard(req)
    if (b.action === 'play' || b.action === 'pause') req.log.info(`cast: ${b.action} asked by ${req.socket.remoteAddress}`)
    switch (b.action) {
      case 'play': return run(() => cast.play())
      case 'pause': return run(() => cast.pause())
      case 'seek':
        if (typeof b.t !== 'number' || !Number.isFinite(b.t)) throw new HttpError(400, 't is required')
        return run(() => cast.seek(b.t as number))
      case 'volume': {
        const v: { level?: number; muted?: boolean } = {}
        if (typeof b.level === 'number' && b.level >= 0 && b.level <= 1) v.level = b.level
        if (typeof b.muted === 'boolean') v.muted = b.muted
        if (v.level === undefined && v.muted === undefined) throw new HttpError(400, 'level (0–1) or muted is required')
        return run(() => cast.setVolume(v))
      }
      case 'subtitle': {
        if (!('subtitle' in b)) throw new HttpError(400, 'subtitle (or null for none) is required')
        const subtitle = parseSubtitle(b.subtitle)
        const subtitles = parseSubtitles(b.subtitles)
        return run(() => cast.setSubtitle(subtitle, subtitles))
      }
      default: throw new HttpError(400, 'action must be play, pause, seek, volume or subtitle')
    }
  })

  app.post('/api/cast/stop', async req => {
    guard(req)
    req.log.info(`cast: stop asked by ${req.socket.remoteAddress} (${String(req.headers['user-agent'] ?? '').slice(0, 80)})`)
    return run(() => cast.stop())
  })
}
