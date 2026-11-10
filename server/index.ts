import Fastify, { type FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, pipeline } from 'node:stream'
import type { ClientCaps, MediaType, OpenSessionRequest, ProbeResponse, ProbeResult } from '../shared/types.ts'
import * as cinemeta from './catalog/cinemeta.ts'
import { config } from './config.ts'
import { EngineError, TorrentEngine, type Session } from './engine/engine.ts'
import { contentType, parseRange } from './engine/range.ts'
import { HttpError, UpstreamError } from './http.ts'
import { detectEncoder, findKeyframe, probe, TranscodeRegistry } from './playback/ffmpeg.ts'
import { buildFfmpegArgs, choosePlan } from './playback/plan.ts'
import { findSources } from './sources/index.ts'
import { scrapeHealth } from './sources/scrape.ts'
import { fetchCues, listSubtitles } from './subtitles.ts'
import { Library } from './library.ts'
import { openDb } from './db.ts'
import { loadCf } from './reco/cf.ts'
import { SqliteTasteStore } from './store.ts'
import { ItemCache } from './taste/items.ts'
import { registerTasteRoutes } from './taste/routes.ts'
import { RecoService } from './taste/service.ts'
import { registerAccountRoutes } from './sync/routes.ts'
import { SyncService } from './sync/service.ts'
import { registerLanGate, registerLanRoutes } from './lan/routes.ts'
import { LanService } from './lan/service.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, exposeHeadRoutes: false })
const engine = new TorrentEngine(config.dataDir, config.idleMinutes * 60_000)
const transcodes = new TranscodeRegistry()
const library = new Library(config.dataDir, engine)
const hw = await detectEncoder({ forced: config.encoder, vaapiDevice: config.vaapiDevice, log: msg => app.log.warn(msg) })
const encoder = hw.device ? `${hw.encoder} (${hw.device})` : hw.encoder
const db = openDb(join(config.dataDir, 'nexttupp.db'))
const tasteStore = new SqliteTasteStore(db)
const itemCache = new ItemCache(db, { baseUrl: config.cinemetaUrl })
const loadCfSafe = () => loadCf(config.dataDir).catch(err => { app.log.warn(`CF model not loaded: ${(err as Error).message}`); return null })
const reco = new RecoService({ store: tasteStore, items: itemCache, cf: await loadCfSafe(), log: msg => app.log.info(msg) })
// Phones and TVs at home (server/lan): a second listener on the home network, behind a cookie gate.
let lan: LanService | undefined
const sync = new SyncService({
  db, store: tasteStore, dataDir: config.dataDir, cloudUrl: config.cloudUrl, log: msg => app.log.info(msg),
  device: () => lan!.deviceInfo(),
  onSignInChange: () => { void lan?.refresh() },
})
lan = new LanService({ dataDir: config.dataDir, port: config.port, host: config.host, signedIn: () => sync.signedIn, log: msg => app.log.info(msg) })
const probes = new Map<string, Promise<ProbeResult>>()
/** Where each copied stream really starts, keyed by `${sessionId}@${t}`. See findKeyframe. */
const streamStarts = new Map<string, Promise<number>>()
const startKey = (id: string, t: number) => `${id}@${t.toFixed(2)}`

const IMDB_ID = /^tt\d{1,10}$/
const STREAM_ID = /^tt\d{1,10}(:\d{1,4}:\d{1,5})?$/
const SESSION_ID = /^[0-9a-f]{40}-\d{1,6}$/
const isType = (t: string): t is MediaType => t === 'movie' || t === 'series'

app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, req, reply) => {
  const status = err instanceof HttpError || err instanceof EngineError ? err.status
    : err instanceof UpstreamError ? 502
    : err.statusCode ?? 500
  if (status >= 500) req.log.error(err)
  reply.code(status).send({ error: err.message })
})

// Before every route: localhost must say so (DNS rebinding), and anything from the network needs a phone's cookie.
registerLanGate(app, lan)

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

// ---- Library (downloads kept for offline viewing) -----------------------------

app.get('/api/library', async () => Promise.all(library.list().map(async e => {
  const s = e.pending ? undefined : engine.get(e.id)
  return { ...e, stats: s ? engine.stats(s) : null, swarm: e.pending || !s ? await engine.swarm(e.infoHash) : null }
})))

interface KeepBody {
  /** Keep the file of an open session (the Download button in the player)… */
  sessionId?: string
  /** …or a source straight from the list, without playing it first. */
  infoHash?: string; fileIdx?: number; fileName?: string; trackers?: string[]
  type?: string; imdbId?: string; streamId?: string; title?: string
}

app.post<{ Body: KeepBody }>('/api/library', async (req, reply) => {
  const { sessionId, infoHash, type, imdbId, streamId, title } = req.body ?? {}
  if (!type || !isType(type) || !imdbId || !IMDB_ID.test(imdbId) || !streamId || !STREAM_ID.test(streamId)) throw new HttpError(400, 'type, imdbId and streamId are required')
  if (!sessionId) {
    if (!infoHash || !/^[0-9a-fA-F]{40}$/.test(infoHash)) throw new HttpError(400, 'sessionId or infoHash is required')
    const { fileIdx, fileName, trackers } = req.body
    const idx = Number.isInteger(fileIdx) && (fileIdx as number) >= 0 && (fileIdx as number) < 100_000 ? fileIdx as number : -1
    const id = `${infoHash.toLowerCase()}-${Math.max(0, idx)}`
    const existing = library.get(id)
    if (existing) return existing
    const open = engine.get(id)
    if (open) {
      engine.pin(open)
      library.add({ id, infoHash: open.infoHash, fileIdx: Number(id.split('-')[1]), fileName: open.file.name, title: (title ?? open.file.name).slice(0, 200), type, imdbId, streamId, addedAt: Date.now() })
      return library.get(id)
    }
    reply.code(202)
    return library.download({
      id, infoHash: infoHash.toLowerCase(), fileIdx: idx,
      fileName: typeof fileName === 'string' ? fileName.slice(0, 500) : '',
      title: (title ?? fileName ?? 'Download').slice(0, 200), type, imdbId, streamId, addedAt: Date.now(),
      trackers: Array.isArray(trackers) ? trackers.filter(t => typeof t === 'string' && /^(udp|https?|wss?):\/\//.test(t)).slice(0, 30) : [],
    })
  }
  const s = session(sessionId)
  engine.pin(s)
  const [hash, fileIdx] = s.id.split('-')
  library.add({ id: s.id, infoHash: hash, fileIdx: Number(fileIdx), fileName: s.file.name, title: (title ?? s.title ?? s.file.name).slice(0, 200), type, imdbId, streamId, addedAt: Date.now() })
  return engine.stats(s)
})

app.delete<{ Params: { id: string }; Querystring: { deleteFiles?: string } }>('/api/library/:id', async (req, reply) => {
  if (!SESSION_ID.test(req.params.id)) throw new HttpError(400, 'Bad id')
  await library.remove(req.params.id, req.query.deleteFiles === '1')
  reply.code(204).send()
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
  const headers: Record<string, string | number> = {
    'accept-ranges': 'bytes',
    'content-type': contentType(s.file.name),
    'content-length': end - start + 1,
    'cache-control': 'no-store',
  }
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
  if (head) return reply.code(range ? 206 : 200).headers(headers).send()

  // Send headers now rather than with the first byte. A client that seeks (ffmpeg, the browser) keeps
  // its previous connection open until the new one answers; answering immediately lets it drop the
  // old one before the torrent has even fetched the new piece.
  reply.hijack()
  reply.raw.writeHead(range ? 206 : 200, headers)
  reply.raw.flushHeaders()
  const release = engine.hold(s)
  const aborter = new AbortController()
  reply.raw.on('close', () => aborter.abort())
  // Timing per range request (LOG_LEVEL=debug): the main signal when diagnosing slow seeks.
  const began = Date.now()
  let firstByteMs = -1
  let sent = 0
  async function * timed () {
    for await (const chunk of engine.read(s, start, end, aborter.signal)) {
      if (firstByteMs < 0) firstByteMs = Date.now() - began
      sent += chunk.length
      yield chunk
    }
  }
  pipeline(Readable.from(timed()), reply.raw, err => {
    release()
    reply.log.debug({ raw: { startPct: +(start / size * 100).toFixed(2), firstByteMs, sentKB: sent >> 10, ms: Date.now() - began, aborted: Boolean(err) } }, 'raw range')
  })
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
  const args = buildFfmpegArgs({ input: rawUrl(s.id), startSec, probe: result, plan, encoder: hw.encoder, hwDevice: hw.device })
  if (plan.copyVideo && startSec > 0) {
    // Runs alongside ffmpeg; both need the same pieces, so this costs no extra waiting.
    const key = startKey(s.id, startSec)
    if (!streamStarts.has(key)) {
      const k = findKeyframe(rawUrl(s.id), startSec, result.container)
      k.catch(() => streamStarts.delete(key))
      streamStarts.set(key, k)
      if (streamStarts.size > 200) streamStarts.delete(streamStarts.keys().next().value!)
    }
  }
  const proc = transcodes.spawn(s.id, args)
  const release = engine.hold(s)
  let stderr = ''
  proc.stderr!.on('data', d => { stderr = (stderr + d).slice(-2000) })
  const began = Date.now()
  proc.stdout!.once('data', () => req.log.debug({ play: { t: startSec, mode: plan.mode, firstOutputMs: Date.now() - began } }, 'ffmpeg output'))
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

/** Film time at which the stream requested with `t` begins (the player's clock origin). */
app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/api/sessions/:id/stream-start', async req => {
  const s = session(req.params.id)
  const t = Number(req.query.t) || 0
  const pending = streamStarts.get(startKey(s.id, t))
  if (!pending) return { start: t, exact: false }
  try { return { start: await pending, exact: true } } catch { return { start: t, exact: false } }
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

// ---- Account and sync (optional) ---------------------------------------------------

registerAccountRoutes(app, sync)
registerLanRoutes(app, lan, { signedIn: () => sync.signedIn, redeemHandoff: (code, id) => sync.redeemHandoff(code, id), nudge: () => sync.nudge() })

// ---- Profiles, taste and recommendations ----------------------------------------

registerTasteRoutes(app, tasteStore, reco)

// ---- Web app (production build) ----------------------------------------------

if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist, wildcard: false })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/stream/')) return reply.code(404).send({ error: 'Not found' })
    return reply.sendFile('index.html')
  })
}

const shutdown = async () => {
  sync.stop()
  lan.stop()
  transcodes.killAll()
  await app.close()
  await engine.destroy()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ port: config.port, host: config.host })
app.log.info(`nexttupp server on http://${config.host}:${config.port} · encoder=${encoder} · data=${config.dataDir}`)
library.resumeAll(msg => app.log.info(msg)).catch(err => app.log.error(err))
sync.start()
await lan.start((req, res) => app.routing(req, res))

// Candidate pool for recommendations: Cinemeta catalogs, refreshed twice a day (pages within TTL are skipped).
const crawl = () => itemCache.crawl(msg => app.log.info(msg)).catch(err => app.log.warn(`catalog crawl: ${(err as Error).message}`))
void crawl()
setInterval(crawl, 12 * 3600_000).unref()
setImmediate(() => reco.prewarm())
// The CF model may be built after the server starts; pick it up when it appears.
setInterval(async () => {
  if (reco.cfAvailable) return
  const cf = await loadCfSafe()
  if (cf) { reco.setCf(cf); app.log.info(`CF model loaded: ${cf.size} movies`) }
}, 10 * 60_000).unref()
