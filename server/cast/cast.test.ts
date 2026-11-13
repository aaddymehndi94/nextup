import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlaybackPlan, ProbeResult } from '../../shared/types.ts'
import { castPlan } from '../playback/plan.ts'
import { toWebVtt } from '../subtitles.ts'
import { CastDiscovery, parseStaticDevices } from './discovery.ts'
import { CastChannel, type CastMessage, DEFAULT_MEDIA_RECEIVER, decodeMessage, encodeFrame, MediaReceiver, NS, readFrames } from './protocol.ts'
import { CastService } from './service.ts'

// Everything here talks to a fake receiver on 127.0.0.1. Nothing reaches a real TV.

/** A stand-in for a Chromecast's Default Media Receiver: the real framing over a local socket. */
class FakeReceiver {
  readonly server: Server
  readonly got: CastMessage[] = []
  port = 0
  sockets: Socket[] = []
  app: { sessionId: string; transportId: string } | null = null
  media: { mediaSessionId: number; playerState: string; currentTime: number } | null = null
  volume = { level: 0.5, muted: false }
  /** Answer LOAD with this type instead of MEDIA_STATUS. */
  failLoad: string | null = null
  /** Media commands answered with INVALID_REQUEST. */
  refuse = new Set<string>()
  /** Report the stream's own timestamps (film time) instead of a clock from 0. */
  absoluteClock = 0
  silent = false

  constructor () {
    this.server = createServer(socket => {
      this.sockets.push(socket)
      let buf: Buffer = Buffer.alloc(0)
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk as Buffer])
        buf = readFrames(buf, body => this.onMessage(socket, decodeMessage(body)))
      })
      socket.on('error', () => {})
    })
  }

  listen (): Promise<number> {
    return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => { this.port = (this.server.address() as { port: number }).port; resolve(this.port) }))
  }

  close () { for (const s of this.sockets) s.destroy(); this.server.close() }

  send (socket: Socket, source: string, destination: string, namespace: string, data: unknown) {
    socket.write(encodeFrame({ source, destination, namespace, payload: JSON.stringify(data) }))
  }

  receiverStatus (requestId = 0) {
    return { type: 'RECEIVER_STATUS', requestId, status: { volume: this.volume, applications: this.app ? [{ appId: DEFAULT_MEDIA_RECEIVER, displayName: 'Default Media Receiver', ...this.app }] : [] } }
  }

  mediaStatus (requestId = 0) {
    return { type: 'MEDIA_STATUS', requestId, status: this.media ? [{ ...this.media, volume: this.volume }] : [] }
  }

  /** Pushes an unsolicited status to every sender (a broadcast). */
  broadcast (namespace: string, data: unknown) {
    for (const s of this.sockets) this.send(s, this.app?.transportId ?? 'receiver-0', '*', namespace, data)
  }

  private onMessage (socket: Socket, m: CastMessage) {
    this.got.push(m)
    if (this.silent) return
    const d = m.data ?? {}
    const id = typeof d.requestId === 'number' ? d.requestId : 0
    const reply = (ns: string, data: unknown) => this.send(socket, m.destination, m.source, ns, data)
    if (m.namespace === NS.heartbeat && d.type === 'PING') return reply(NS.heartbeat, { type: 'PONG' })
    if (m.namespace === NS.receiver) {
      if (d.type === 'LAUNCH') { this.app = { sessionId: 'APP-SESSION-1', transportId: 'web-5' }; return reply(NS.receiver, this.receiverStatus(id)) }
      if (d.type === 'SET_VOLUME') { Object.assign(this.volume, d.volume); return reply(NS.receiver, this.receiverStatus(id)) }
      if (d.type === 'STOP') { this.app = null; this.media = null; return reply(NS.receiver, this.receiverStatus(id)) }
      if (d.type === 'GET_STATUS') return reply(NS.receiver, this.receiverStatus(id))
    }
    if (m.namespace === NS.media && m.destination === 'web-5') {
      if (d.type === 'LOAD') {
        if (this.failLoad) return reply(NS.media, { type: this.failLoad, requestId: id })
        const t = Number(d.currentTime) || 0
        this.media = { mediaSessionId: (this.media?.mediaSessionId ?? 0) + 1, playerState: 'PLAYING', currentTime: this.absoluteClock ? this.absoluteClock + t : t }
        return reply(NS.media, this.mediaStatus(id))
      }
      if (!this.media) return reply(NS.media, { type: 'INVALID_PLAYER_STATE', requestId: id })
      if (this.refuse.has(String(d.type))) return reply(NS.media, { type: 'INVALID_REQUEST', requestId: id, reason: 'INVALID_COMMAND' })
      if (d.type === 'PLAY') this.media.playerState = 'PLAYING'
      if (d.type === 'PAUSE') this.media.playerState = 'PAUSED'
      if (d.type === 'SEEK') this.media.currentTime = Number(d.currentTime)
      return reply(NS.media, this.mediaStatus(id))
    }
  }
}

const fakes: FakeReceiver[] = []
const closers: Array<() => void> = []
afterEach(() => {
  for (const f of fakes.splice(0)) f.close()
  for (const c of closers.splice(0)) c()
})

async function fake () {
  const f = new FakeReceiver()
  fakes.push(f)
  await f.listen()
  return f
}

/** Plain TCP to the fake instead of TLS; everything above the socket is the real code. */
const tcp = (port: number) => ({ socket: () => connect(port, '127.0.0.1') })
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sent = (f: FakeReceiver, type: string) => f.got.filter(m => m.data?.type === type)

describe('the Cast v2 wire format', () => {
  it('round-trips a CastMessage and splits frames that arrive in pieces', () => {
    const frame = encodeFrame({ source: 'sender-1', destination: 'receiver-0', namespace: NS.receiver, payload: JSON.stringify({ type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER, requestId: 7, note: 'é'.repeat(100) }) })
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4)
    const two = Buffer.concat([frame, frame])
    const bodies: Buffer[] = []
    let rest = readFrames(two.subarray(0, 50), b => bodies.push(b))
    expect(bodies).toHaveLength(0)
    rest = readFrames(Buffer.concat([rest, two.subarray(50)]), b => bodies.push(b))
    expect(rest.length).toBe(0)
    expect(bodies).toHaveLength(2)
    const m = decodeMessage(bodies[1])
    expect(m).toMatchObject({ source: 'sender-1', destination: 'receiver-0', namespace: NS.receiver })
    expect(m.data).toMatchObject({ type: 'LAUNCH', appId: 'CC1AD845', requestId: 7 })
  })

  it('refuses absurd frame sizes', () => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(10 * 1024 * 1024)
    expect(() => readFrames(head, () => {})).toThrow(/too large/)
  })
})

describe('the Default Media Receiver client', () => {
  it('connects, launches CC1AD845, loads a URL and controls it', async () => {
    const f = await fake()
    const r = await MediaReceiver.connect('127.0.0.1', f.port, tcp(f.port))
    closers.push(() => r.close())
    await r.launch()
    expect(f.got[0]).toMatchObject({ destination: 'receiver-0', namespace: NS.connection, data: { type: 'CONNECT' } })
    expect(sent(f, 'LAUNCH')[0]).toMatchObject({ destination: 'receiver-0', data: { appId: 'CC1AD845' } })
    await wait(20)
    expect(f.got.some(m => m.destination === 'web-5' && m.data?.type === 'CONNECT')).toBe(true)

    const textTracks = [{ url: 'http://192.168.1.20:4552/cast/tok1/subs.vtt', language: 'en' }, { url: 'http://192.168.1.20:4552/cast/tok2/subs.vtt', language: 'fr' }]
    const status = await r.load({ contentId: 'http://192.168.1.20:4552/cast/tok/raw', contentType: 'video/mp4', currentTime: 42, title: 'Charade', image: 'https://example.com/p.jpg', textTracks, activeTextTrack: 1 })
    expect(status).toMatchObject({ playerState: 'PLAYING', currentTime: 42, mediaSessionId: 1 })
    const load = sent(f, 'LOAD')[0]
    expect(load.destination).toBe('web-5')
    expect(load.data).toMatchObject({ autoplay: true, currentTime: 42, activeTrackIds: [2], media: { contentId: 'http://192.168.1.20:4552/cast/tok/raw', contentType: 'video/mp4', streamType: 'BUFFERED' } })
    expect((load.data!.media as { tracks: unknown[] }).tracks).toMatchObject([
      { trackId: 1, type: 'TEXT', trackContentType: 'text/vtt', trackContentId: textTracks[0].url, language: 'en' },
      { trackId: 2, type: 'TEXT', trackContentType: 'text/vtt', trackContentId: textTracks[1].url, language: 'fr' },
    ])

    // Subtitles switch in place, by track id; off is an empty list.
    await r.showTextTrack(0)
    await r.showTextTrack(null)
    expect(sent(f, 'EDIT_TRACKS_INFO').map(m => m.data)).toMatchObject([{ mediaSessionId: 1, activeTrackIds: [1] }, { mediaSessionId: 1, activeTrackIds: [] }])
    expect(sent(f, 'LOAD')).toHaveLength(1)

    expect((await r.pause())?.playerState).toBe('PAUSED')
    expect((await r.play())?.playerState).toBe('PLAYING')
    expect((await r.seek(100))?.currentTime).toBe(100)
    expect(sent(f, 'SEEK')[0].data).toMatchObject({ mediaSessionId: 1, currentTime: 100 })
    await r.setVolume({ level: 0.2 })
    expect(f.volume.level).toBe(0.2)
    await r.stopApp()
    expect(sent(f, 'STOP')[0].data).toMatchObject({ sessionId: 'APP-SESSION-1' })
    expect(r.closed).toBe(true)
  })

  it('answers the receiver’s PINGs and gives up on a silent receiver', async () => {
    const f = await fake()
    const ch = await CastChannel.connect('127.0.0.1', f.port, { ...tcp(f.port), heartbeatMs: 20, timeoutMs: 120 })
    closers.push(() => ch.close())
    const closed = new Promise<Error | undefined>(resolve => ch.once('close', resolve))
    f.sockets[0] ?? await wait(20)
    f.send(f.sockets[0], 'receiver-0', ch.sender, NS.heartbeat, { type: 'PING' })
    await wait(40)
    expect(sent(f, 'PONG').length).toBe(1)
    expect(sent(f, 'PING').length).toBeGreaterThan(0)
    f.silent = true
    const err = await closed
    expect(err?.message).toMatch(/stopped answering/)
  })

  it('reports a failed load', async () => {
    const f = await fake()
    f.failLoad = 'LOAD_FAILED'
    const r = await MediaReceiver.connect('127.0.0.1', f.port, tcp(f.port))
    closers.push(() => r.close())
    await r.launch()
    await expect(r.load({ contentId: 'http://x/y', contentType: 'video/mp4', currentTime: 0 })).rejects.toThrow(/couldn’t play/)
  })
})

// ---- The cast service, with a fake receiver, LAN and playback pipeline ----------------------

const PLAN: Record<string, PlaybackPlan> = {
  direct: { mode: 'direct', audioTrack: 0, copyVideo: true, copyAudio: true, reason: '' },
  remux: { mode: 'remux', audioTrack: 0, copyVideo: true, copyAudio: false, reason: '' },
  transcode: { mode: 'transcode', audioTrack: 0, copyVideo: false, copyAudio: false, reason: '' },
}
const SESSION = `${'a'.repeat(40)}-0`

async function service (mode: keyof typeof PLAN, opts: { keyframe?: number } = {}) {
  const f = await fake()
  const lan = { port: 4552, holds: 0, held: 0, holdForCast () { this.holds++; this.held++; let done = false; return () => { if (!done) { done = true; this.held-- } } }, refresh: async () => {}, addressFor: async () => '192.168.1.20' }
  const cast = new CastService({
    discovery: new CastDiscovery({ staticDevices: parseStaticDevices(`Living Room TV@127.0.0.1:${f.port}`) }),
    lan,
    media: {
      plan: async () => ({ plan: PLAN[mode], durationSec: 6000, contentType: 'video/mp4' }),
      streamStart: async (_id, t) => opts.keyframe ?? t,
    },
    connect: d => MediaReceiver.connect(d.host, d.port, tcp(d.port)),
    pollMs: 50,
  })
  closers.push(() => cast.shutdown())
  return { f, lan, cast }
}

const loadUrl = (f: FakeReceiver, i = -1) => (sent(f, 'LOAD').at(i)!.data!.media as { contentId: string }).contentId
const tokenOf = (url: string) => /\/cast\/([A-Za-z0-9_-]{43})\//.exec(url)![1]

describe('casting', () => {
  it('direct play: the TV gets a tokenised raw URL on the LAN address and seeks itself', async () => {
    const { f, lan, cast } = await service('direct')
    const s = await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 120, title: 'Charade', streamId: 'tt0056923' })
    expect(s).toMatchObject({ active: true, state: 'playing', device: { name: 'Living Room TV' }, mode: 'direct', sessionId: SESSION, streamId: 'tt0056923' })
    expect(s.position).toBeGreaterThanOrEqual(120)
    expect(lan.held).toBe(1)
    const url = loadUrl(f)
    expect(url).toMatch(/^http:\/\/192\.168\.1\.20:4552\/cast\/[A-Za-z0-9_-]{43}\/raw$/)
    expect(sent(f, 'LOAD')[0].data).toMatchObject({ currentTime: 120 })

    // Only the TV (or this computer) may use the token.
    const token = tokenOf(url)
    expect(cast.verify(token, '127.0.0.1')).toMatchObject({ sessionId: SESSION })
    expect(cast.verify(token, '192.168.1.77')).toBeNull()
    expect(cast.verify('x'.repeat(43), '127.0.0.1')).toBeNull()

    const seeked = await cast.seek(900)
    expect(sent(f, 'SEEK')[0].data).toMatchObject({ currentTime: 900 })
    expect(sent(f, 'LOAD')).toHaveLength(1)
    expect(seeked.position).toBeGreaterThanOrEqual(900)
    expect((await cast.pause()).state).toBe('paused')
    expect((await cast.setVolume({ level: 0.3 })).volume).toBe(0.3)
  })

  it('a converted stream starts at ?t= and a seek reloads it, keeping the old URL briefly', async () => {
    const { f, cast } = await service('remux', { keyframe: 118.5 })
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 120 })
    const first = loadUrl(f)
    expect(first).toMatch(/\/cast\/[A-Za-z0-9_-]{43}\/play\.mp4\?t=120\.00$/)
    expect(sent(f, 'LOAD')[0].data).toMatchObject({ currentTime: 0 })
    await wait(10)
    // The TV's clock restarts at 0; film time = where the stream really starts (the keyframe) + its clock.
    expect(cast.status().position).toBeGreaterThanOrEqual(118.5)
    expect(cast.status().position).toBeLessThan(119.5)

    await cast.seek(3000)
    const second = loadUrl(f)
    expect(second).toMatch(/play\.mp4\?t=3000\.00$/)
    expect(tokenOf(second)).not.toBe(tokenOf(first))
    expect(cast.verify(tokenOf(first), '127.0.0.1')).not.toBeNull()
    expect(sent(f, 'SEEK')).toHaveLength(0)
  })

  it('copes with a receiver that reports the stream’s own timestamps', async () => {
    const { f, cast } = await service('transcode')
    f.absoluteClock = 2000
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 2000 })
    await wait(80)
    const p = cast.status().position!
    expect(p).toBeGreaterThanOrEqual(2000)
    expect(p).toBeLessThan(2002)
  })

  it('subtitles go to the TV as a WebVTT track shifted to the stream’s start', async () => {
    const { f, cast } = await service('remux', { keyframe: 597 })
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 600, subtitle: { url: 'https://subs5.strem.io/en/x.srt', lang: 'en', label: 'English', offset: 0.5 } })
    const load = sent(f, 'LOAD')[0].data!
    const tracks = (load.media as { tracks: Array<{ trackContentId: string }> }).tracks
    expect(tracks[0].trackContentId).toMatch(/\/cast\/[A-Za-z0-9_-]{43}\/subs\.vtt$/)
    expect(load.activeTrackIds).toEqual([1])
    expect(cast.verify(tokenOf(tracks[0].trackContentId), '127.0.0.1')).toMatchObject({ origin: 597, subtitle: { url: 'https://subs5.strem.io/en/x.srt', offset: 0.5 } })
  })

  const SUBS = ['en/a', 'fr/b', 'es/c'].map(p => ({ url: `https://subs5.strem.io/${p}.srt`, lang: p.slice(0, 2), label: p }))
  const tracksOf = (f: FakeReceiver, i = -1) => (sent(f, 'LOAD').at(i)!.data!.media as { tracks?: Array<{ trackId: number; trackContentId: string }> }).tracks ?? []

  it('loads every subtitle the viewer can pick as a track, each URL with its own token', async () => {
    const { f, cast } = await service('remux', { keyframe: 1195 })
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 1200, subtitle: { ...SUBS[1], offset: -1 }, subtitles: [...SUBS, SUBS[0]] })
    const tracks = tracksOf(f)
    expect(tracks.map(t => t.trackId)).toEqual([1, 2, 3])
    expect(sent(f, 'LOAD')[0].data!.activeTrackIds).toEqual([2])
    const grants = tracks.map(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1'))
    expect(grants.map(g => g?.subtitle?.url)).toEqual(SUBS.map(s => s.url))
    expect(grants.map(g => g?.subtitle?.offset ?? 0)).toEqual([0, -1, 0])
    expect(new Set(tracks.map(t => tokenOf(t.trackContentId))).size).toBe(3)
    expect(grants.every(g => g?.origin === 1195)).toBe(true)
  })

  it('turning subtitles off, on or to another language switches tracks on the TV, without a reload', async () => {
    const { f, cast } = await service('remux', { keyframe: 1195 })
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 1200, subtitle: null, subtitles: SUBS })
    expect(sent(f, 'LOAD')[0].data!.activeTrackIds).toEqual([])
    await wait(10)
    // Nothing showed at the start, so the keyframe lookup ran in the background; the tracks get its result.
    expect(cast.verify(tokenOf(tracksOf(f)[2].trackContentId), '127.0.0.1')).toMatchObject({ origin: 1195 })

    f.media!.currentTime = 30
    const on = await cast.setSubtitle(SUBS[2])
    const changed = await cast.setSubtitle(SUBS[0])
    const off = await cast.setSubtitle(null)
    expect(sent(f, 'EDIT_TRACKS_INFO').map(m => m.data!.activeTrackIds)).toEqual([[3], [1], []])
    expect(sent(f, 'LOAD')).toHaveLength(1)
    for (const s of [on, changed, off]) expect(s).toMatchObject({ active: true, state: 'playing' })
    expect(off.position).toBeGreaterThanOrEqual(1225)

    // A seek reloads a converted stream: the subtitle that's showing stays on.
    await cast.setSubtitle(SUBS[1])
    await cast.seek(3000)
    expect(sent(f, 'LOAD')).toHaveLength(2)
    expect(sent(f, 'LOAD')[1].data!.activeTrackIds).toEqual([2])
    expect(tracksOf(f).map(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1')?.subtitle?.url)).toEqual(SUBS.map(s => s.url))
  })

  it('a subtitle the TV wasn’t loaded with, or a TV that refuses the switch, reloads from where it is', async () => {
    const { f, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 500, subtitle: SUBS[0] })
    expect(tracksOf(f)).toHaveLength(1)
    f.media!.currentTime = 640
    await wait(80) // the service's status poll hears where the TV is
    const extra = { url: 'https://subs5.strem.io/de/d.srt', lang: 'de', label: 'German' }
    await cast.setSubtitle(extra, SUBS)
    expect(sent(f, 'EDIT_TRACKS_INFO')).toHaveLength(0)
    expect(sent(f, 'LOAD')).toHaveLength(2)
    const reload = sent(f, 'LOAD')[1].data!
    expect(reload.currentTime).toBeGreaterThanOrEqual(640)
    expect(tracksOf(f).map(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1')?.subtitle?.url)).toEqual([extra.url, ...SUBS.map(s => s.url)])
    expect(reload.activeTrackIds).toEqual([1])

    // From now on the player's whole list switches in place.
    await cast.setSubtitle(SUBS[2])
    expect(sent(f, 'EDIT_TRACKS_INFO').map(m => m.data!.activeTrackIds)).toEqual([[4]])
    expect(sent(f, 'LOAD')).toHaveLength(2)

    f.refuse.add('EDIT_TRACKS_INFO')
    await cast.setSubtitle(null)
    expect(sent(f, 'LOAD')).toHaveLength(3)
    expect(sent(f, 'LOAD')[2].data!.activeTrackIds).toEqual([])
  })

  it('seeks that queue up behind one in progress collapse into the newest', async () => {
    const { f, cast } = await service('remux')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 100 })
    const results = await Promise.all([cast.seek(110), cast.seek(120), cast.seek(130)])
    expect(sent(f, 'LOAD')).toHaveLength(2)
    expect(loadUrl(f)).toMatch(/play\.mp4\?t=130\.00$/)
    for (const r of results) expect(r.position).toBeGreaterThanOrEqual(130)
  })

  it('stop quits the TV’s player, revokes the URLs, frees the LAN listener and says where it was', async () => {
    const { f, lan, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 300 })
    const token = tokenOf(loadUrl(f))
    const last = await cast.stop()
    expect(last).toMatchObject({ active: false, state: 'stopped' })
    expect(last.position).toBeGreaterThanOrEqual(300)
    expect(sent(f, 'STOP')).toHaveLength(1)
    expect(cast.verify(token, '127.0.0.1')).toBeNull()
    expect(lan.held).toBe(0)
    expect(cast.status()).toEqual({ active: false })
  })

  it('notices the end of the film, and another app taking over the TV', async () => {
    const { f, lan, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0 })
    f.media!.playerState = 'IDLE'
    f.broadcast(NS.media, { type: 'MEDIA_STATUS', requestId: 0, status: [{ ...f.media, idleReason: 'FINISHED' }] })
    await wait(50)
    expect(cast.status()).toMatchObject({ active: false, state: 'ended' })
    expect(lan.held).toBe(0)

    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0 })
    expect(lan.held).toBe(1)
    f.app = { sessionId: 'SOMEONE-ELSE', transportId: 'web-9' }
    f.broadcast(NS.receiver, f.receiverStatus())
    await wait(50)
    expect(cast.status()).toMatchObject({ active: false, state: 'stopped' })
    expect(lan.held).toBe(0)
  })

  it('a TV that can’t play the stream leaves nothing running', async () => {
    const { f, lan, cast } = await service('direct')
    f.failLoad = 'LOAD_FAILED'
    await expect(cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0 })).rejects.toThrow(/couldn’t play/)
    expect(lan.held).toBe(0)
    expect(cast.status().active).toBe(false)
    await expect(cast.start({ deviceId: 'nope', sessionId: SESSION, t: 0 })).rejects.toThrow(/isn’t on the network/)
    await expect(cast.pause()).rejects.toThrow(/Nothing is casting/)
  })
})

// ---- The cast capability profile ------------------------------------------------------------

function probe (over: Partial<ProbeResult> & { v?: Partial<NonNullable<ProbeResult['video']>>; a?: string[] }): ProbeResult {
  return {
    durationSec: 6000,
    container: over.container ?? 'mkv',
    video: { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 1920, height: 1080, hdr: false, ...over.v },
    audio: (over.a ?? ['aac']).map((codec, index) => ({ index, codec, default: index === 0, language: 'eng', channels: 6 })),
    subtitles: [],
  }
}

describe('the cast plan (H.264 8-bit + AAC in MP4)', () => {
  it('plays H.264 + AAC MP4 directly', () => {
    expect(castPlan(probe({ container: 'mp4' }), ['en']).mode).toBe('direct')
    expect(castPlan(probe({ container: 'mp4', a: ['mp3'] }), ['en']).mode).toBe('direct')
  })
  it('repackages MKV, converting AC3/EAC3/DTS to AAC', () => {
    expect(castPlan(probe({}), ['en'])).toMatchObject({ mode: 'remux', copyVideo: true, copyAudio: true })
    for (const a of ['ac3', 'eac3', 'dts', 'truehd', 'opus', 'flac']) {
      expect(castPlan(probe({ a: [a] }), ['en']), a).toMatchObject({ mode: 'remux', copyVideo: true, copyAudio: false })
      expect(castPlan(probe({ container: 'mp4', a: [a] }), ['en']).mode, a).toBe('remux')
    }
    expect(castPlan(probe({ container: 'webm' }), ['en']).mode).toBe('remux')
  })
  it('converts HEVC, 10-bit, HDR and 4K video to 1080p H.264', () => {
    expect(castPlan(probe({ v: { codec: 'hevc' } }), ['en'])).toMatchObject({ mode: 'transcode', copyVideo: false })
    expect(castPlan(probe({ v: { codec: 'hevc', pixFmt: 'yuv420p10le', hdr: true } }), ['en']).mode).toBe('transcode')
    expect(castPlan(probe({ v: { pixFmt: 'yuv420p10le', profile: 'High 10' } }), ['en']).mode).toBe('transcode')
    expect(castPlan(probe({ container: 'mp4', v: { width: 3840, height: 2160 } }), ['en'])).toMatchObject({ mode: 'transcode', reason: expect.stringMatching(/1080p/) })
    expect(castPlan(probe({ v: { codec: 'av1' } }), ['en']).mode).toBe('transcode')
  })
  it('speaks of the TV, not the browser', () => {
    expect(castPlan(probe({ v: { codec: 'hevc' } }), ['en']).reason).not.toMatch(/browser/)
  })
})

describe('finding TVs', () => {
  it('assembles a device from PTR, SRV, TXT and A records arriving in separate packets', () => {
    const queries: unknown[] = []
    const d = new CastDiscovery({ mdns: () => ({ on () {}, query (q: unknown) { queries.push(q) }, destroy () {} }) })
    void d.browse(0)
    const instance = 'Chromecast-abc123._googlecast._tcp.local'
    d.onResponse({ answers: [{ name: '_googlecast._tcp.local', type: 'PTR', data: instance }] })
    expect(d.list()).toEqual([])
    d.onResponse({ answers: [
      { name: instance, type: 'SRV', data: { port: 8009, target: 'abc123.local' } },
      { name: instance, type: 'TXT', data: [Buffer.from('id=abc123'), Buffer.from('fn=Living Room TV'), Buffer.from('md=Chromecast')] },
    ] })
    expect(d.list()).toEqual([])
    d.onResponse({ additionals: [{ name: 'abc123.local', type: 'A', data: '192.168.1.40' }] })
    expect(d.list()).toMatchObject([{ id: 'abc123', name: 'Living Room TV', model: 'Chromecast', host: '192.168.1.40', port: 8009 }])
    // It asked for what was missing.
    expect(JSON.stringify(queries)).toContain('abc123.local')
    d.close()
  })

  it('takes a fixed list from NEXTTUPP_CAST_DEVICES', () => {
    expect(parseStaticDevices('Fake TV@127.0.0.1:18009')).toMatchObject([{ id: 'static-0', name: 'Fake TV', host: '127.0.0.1', port: 18009 }])
    expect(parseStaticDevices(undefined)).toBeNull()
    expect(() => parseStaticDevices('nonsense')).toThrow()
  })
})

describe('WebVTT for the TV', () => {
  it('shifts cues to the stream’s clock and drops the ones before it', () => {
    const vtt = toWebVtt([{ start: 1, end: 2, text: 'gone' }, { start: 601.5, end: 603, text: 'Hello\n\nthere --> you' }], -600)
    expect(vtt).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello\nthere → you\n')
  })
})
