import Fastify, { type FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { ClientCaps, MediaType, OpenSessionRequest, ProbeResponse, ProbeResult } from '../shared/types.ts'
import * as cinemeta from './catalog/cinemeta.ts'
import { config } from './config.ts'
import { EngineError, TorrentEngine, type Session } from './engine/engine.ts'
import { contentType, parseRange } from './engine/range.ts'
import { UpstreamError } from './http.ts'
import { detectEncoder, probe, TranscodeRegistry } from './playback/ffmpeg.ts'
import { buildFfmpegArgs, choosePlan } from './playback/plan.ts'
import { findSources } from './sources/index.ts'
import { scrapeHealth } from './sources/scrape.ts'
import { fetchCues, listSubtitles } from './subtitles.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, exposeHeadRoutes: false })
const engine = new TorrentEngine(config.dataDir, config.idleMinutes * 60_000)
const transcodes = new TranscodeRegistry()
const encoder = await detectEncoder()
const probes = new Map<string, Promise<ProbeResult>>()

const IMDB_ID = /^tt\d{1,10}$/
const STREAM_ID = /^tt\d{1,10}(:\d{1,4}:\d{1,5})?$/
const SESSION_ID = /^[0-9a-f]{40}-\d{1,6}$/
const isType = (t: string): t is MediaType => t === 'movie' || t === 'series'

class HttpError extends Error {
  readonly status: number
  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, req, reply) => {
  const status = err instanceof HttpError || err instanceof EngineError ? err.status
    : err instanceof UpstreamError ? 502
    : err.statusCode ?? 500
  if (status >= 500) req.log.error(err)
  reply.code(status).send({ error: err.message })
})

function session (id: string): Session {
  if (!SESSION_ID.test(id)) throw new HttpError(400, 'Bad session id')
  const s = engine.get(id)
  if (!s) throw new HttpError(404, 'Session not found or expired. Pick the source again.')
  return s
}

const rawUrl = (id: string) => `http://127.0.0.1:${config.port}/stream/${id}/raw`

function getProbe (s: Session): Promise<ProbeResult> {
  let p = probes.get(s.id)
  if (!p) {
    p = probe(rawUrl(s.id), s.file.name)
    p.catch(() => probes.delete(s.id))
    probes.set(s.id, p)
  }
  return p
}

const CAP_KEYS: Array<keyof ClientCaps> = ['h264', 'hevc', 'hevc10', 'av1', 'vp9', 'aac', 'ac3', 'eac3', 'opus', 'mp3', 'flac']
function parseCaps (raw: string | undefined): ClientCaps {
  // Default to the safe baseline every browser supports.
  const list = new Set((raw ?? 'h264,aac,mp3').split(','))
  return Object.fromEntries(CAP_KEYS.map(k => [k, list.has(k)])) as unknown as ClientCaps
}

// ---- Catalog ---------------------------------------------------------------

app.get('/api/health', async () => ({ ok: true, encoder }))

app.get<{ Querystring: { q?: string } }>('/api/search', async req => {
  const q = (req.query.q ?? '').trim()
  if (q.length < 1) return []
  if (q.length > 100) throw new HttpError(400, 'Query too long')
  return cinemeta.search(q)
})

app.get<{ Params: { type: string } }>('/api/popular/:type', async req => {
  if (!isType(req.params.type)) throw new HttpError(400, 'Bad type')
  return cinemeta.popular(req.params.type)
})

app.get<{ Params: { type: string; id: string } }>('/api/title/:type/:id', async req => {
  const { type, id } = req.params
  if (!isType(type) || !IMDB_ID.test(id)) throw new HttpError(400, 'Bad title id')
  return cinemeta.detail(type, id)
})

// ---- Sources ---------------------------------------------------------------

app.get<{ Params: { type: string; id: string } }>('/api/sources/:type/:id', async req => {
  const { type, id } = req.params
  if (!isType(type) || !STREAM_ID.test(id)) throw new HttpError(400, 'Bad id')
  const [imdbId, season, episode] = id.split(':')
  const meta = await cinemeta.detail(type, imdbId).catch(() => null)
  const runtimeMin = Number.parseInt(meta?.runtime ?? '') || undefined
  return findSources({
    type,
    imdbId,
    season: season ? Number(season) : undefined,
    episode: episode ? Number(episode) : undefined,
    name: meta?.name ?? '',
    year: meta?.year,
  }, runtimeMin)
})

app.get<{ Querystring: { h?: string } }>('/api/swarm', async req => {
  const hashes = (req.query.h ?? '').split(',').filter(Boolean).slice(0, 140)
  return scrapeHealth(hashes, 3000)
})

// ---- Sessions (one playable file in a torrent) -----------------------------

app.post<{ Body: OpenSessionRequest }>('/api/sessions', async req => {
  const body = req.body
  if (!body || typeof body.infoHash !== 'string') throw new HttpError(400, 'infoHash required')
  const s = await engine.open({
    infoHash: body.infoHash,
    fileIdx: Number.isInteger(body.fileIdx) ? body.fileIdx : undefined,
    fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
    trackers: Array.isArray(body.trackers) ? body.trackers.filter(t => typeof t === 'string' && /^(udp|https?|wss?):\/\//.test(t)).slice(0, 30) : [],
    title: typeof body.title === 'string' ? body.title.slice(0, 200) : undefined,
  })
  return engine.stats(s)
})

app.get('/api/sessions', async () => engine.list().map(s => engine.stats(s)))

app.get<{ Params: { id: string } }>('/api/sessions/:id', async req => engine.stats(session(req.params.id)))

app.get<{ Params: { id: string }; Querystring: { caps?: string; audio?: string } }>('/api/sessions/:id/probe', async (req): Promise<ProbeResponse> => {
  const s = session(req.params.id)
  const result = await getProbe(s)
  const audio = req.query.audio !== undefined ? Number(req.query.audio) : undefined
  return { probe: result, plan: choosePlan(result, parseCaps(req.query.caps), config.preferredLanguages, audio) }
})

app.post<{ Params: { id: string } }>('/api/sessions/:id/pin', async req => {
  const s = session(req.params.id)
  engine.pin(s)
  return engine.stats(s)
})

app.delete<{ Params: { id: string } }>('/api/sessions/:id/pin', async req => {
  const s = session(req.params.id)
  engine.unpin(s)
  return engine.stats(s)
})

app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
  const s = session(req.params.id)
  await engine.close(s)
  probes.delete(s.id)
  reply.code(204).send()
})

// ---- Streaming --------------------------------------------------------------

/** Raw bytes of the file with HTTP Range support. Used for direct play and as ffmpeg's input. */
async function serveRaw (id: string, rangeHeader: string | undefined, head: boolean, reply: FastifyReply) {
  const s = session(id)
  const size = s.file.length
  const range = parseRange(rangeHeader, size)
  if (range === 'invalid') {
    return reply.code(416).header('content-range', `bytes */${size}`).send()
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  reply
    .code(range ? 206 : 200)
    .header('accept-ranges', 'bytes')
    .header('content-type', contentType(s.file.name))
    .header('content-length', end - start + 1)
    .header('cache-control', 'no-store')
  if (range) reply.header('content-range', `bytes ${start}-${end}/${size}`)
  if (head) return reply.send()
  const release = engine.hold(s)
  reply.raw.on('close', release)
  return reply.send(Readable.from(engine.read(s, start, end)))
}

app.get<{ Params: { id: string } }>('/stream/:id/raw', (req, reply) => serveRaw(req.params.id, req.headers.range, false, reply))
app.head<{ Params: { id: string } }>('/stream/:id/raw', (req, reply) => serveRaw(req.params.id, req.headers.range, true, reply))

/** Remuxed / transcoded fragmented MP4, starting at `t` seconds. Seeking = a new request with a new `t`. */
app.get<{ Params: { id: string }; Querystring: { t?: string; audio?: string; caps?: string } }>('/stream/:id/play.mp4', async (req, reply) => {
  const s = session(req.params.id)
  const result = await getProbe(s)
  const audio = req.query.audio !== undefined ? Number(req.query.audio) : undefined
  const plan = choosePlan(result, parseCaps(req.query.caps), config.preferredLanguages, audio)
  const startSec = Math.max(0, Math.min(Number(req.query.t) || 0, Math.max(0, result.durationSec - 1)))
  const args = buildFfmpegArgs({ input: rawUrl(s.id), startSec, probe: result, plan, encoder })
  const proc = transcodes.spawn(s.id, args)
  const release = engine.hold(s)
  let stderr = ''
  proc.stderr!.on('data', d => { stderr = (stderr + d).slice(-2000) })
  proc.on('close', code => {
    if (code && code !== 255 && !reply.raw.destroyed) req.log.warn({ code, stderr: stderr.trim() }, 'ffmpeg exited')
  })
  reply.raw.on('close', () => { proc.kill('SIGKILL'); release() })
  return reply
    .header('content-type', 'video/mp4')
    .header('cache-control', 'no-store')
    .header('x-playback-mode', plan.mode)
    .send(proc.stdout)
})

// ---- Subtitles --------------------------------------------------------------

app.get<{ Params: { type: string; id: string }; Querystring: { file?: string } }>('/api/subtitles/:type/:id', async req => {
  const { type, id } = req.params
  if (!isType(type) || !STREAM_ID.test(id)) throw new HttpError(400, 'Bad id')
  return listSubtitles(type, id, req.query.file?.slice(0, 300))
})

app.get<{ Querystring: { url?: string } }>('/api/subtitle-cues', async req => {
  if (!req.query.url) throw new HttpError(400, 'url required')
  return fetchCues(req.query.url)
})

// ---- Web app (production build) ----------------------------------------------

if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist, wildcard: false })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/stream/')) return reply.code(404).send({ error: 'Not found' })
    return reply.sendFile('index.html')
  })
}

const shutdown = async () => {
  transcodes.killAll()
  await app.close()
  await engine.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ port: config.port, host: config.host })
app.log.info(`nextup server on http://${config.host}:${config.port} · encoder=${encoder} · data=${config.dataDir}`)
