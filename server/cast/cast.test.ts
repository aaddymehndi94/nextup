import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlaybackPlan, ProbeResult } from '../../shared/types.ts'
import { castPlan } from '../playback/plan.ts'
import { toWebVtt } from '../subtitles.ts'
import { CastDiscovery, parseStaticDevices } from './discovery.ts'
import { CastChannel, type CastMessage, DEFAULT_MEDIA_RECEIVER, decodeMessage, encodeFrame, MediaReceiver, NS, readFrames } from './protocol.ts'
import { type CastMedia, type CastProgress, CastService } from './service.ts'

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
  /** Where a converted stream really starts (the keyframe before the time asked for): the TV's clock reads from there. */
  startsAt: number | null = null
  /** A TV whose clock restarts at 0 for each stream, whatever the stream's own timestamps. */
  zeroClock = false
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
    // As on a real TV: a media status carries the stream's volume, not the TV's.
    return { type: 'MEDIA_STATUS', requestId, status: this.media ? [{ ...this.media, volume: { level: 1, muted: false } }] : [] }
  }

  /** The connection drops (Wi-Fi), without a goodbye; the player keeps playing. */
  drop () { for (const s of this.sockets.splice(0)) s.destroy() }

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
        this.media = { mediaSessionId: (this.media?.mediaSessionId ?? 0) + 1, playerState: 'PLAYING', currentTime: this.zeroClock ? 0 : this.startsAt ?? t }
        return reply(NS.media, this.mediaStatus(id))
      }
      if (d.type === 'GET_STATUS') return reply(NS.media, this.mediaStatus(id))
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

async function service (mode: keyof typeof PLAN, opts: { media?: Partial<CastMedia>; onProgress?: (p: CastProgress) => void } = {}) {
  const f = await fake()
  const lan = { port: 4552, holds: 0, held: 0, holdForCast () { this.holds++; this.held++; let done = false; return () => { if (!done) { done = true; this.held-- } } }, refresh: async () => {}, addressFor: async () => '192.168.1.20' }
  const cast = new CastService({
    discovery: new CastDiscovery({ staticDevices: parseStaticDevices(`Living Room TV@127.0.0.1:${f.port}`) }),
    lan,
    media: {
      plan: async () => ({ plan: PLAN[mode], durationSec: 6000, contentType: 'video/mp4' }),
      ...opts.media,
    },
    connect: d => MediaReceiver.connect(d.host, d.port, tcp(d.port)),
    pollMs: 50,
    rejoinDelays: [0, 20, 20],
    subtitleRetryMs: [15, 15, 15, 15, 15, 15, 15, 15],
    onProgress: opts.onProgress,
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
    const { f, cast } = await service('remux')
    f.startsAt = 118.5
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 120 })
    const first = loadUrl(f)
    expect(first).toMatch(/\/cast\/[A-Za-z0-9_-]{43}\/play\.mp4\?t=120\.00$/)
    // The stream carries film time and the film's length, so the TV's own seek bar reads where the film is.
    expect(sent(f, 'LOAD')[0].data).toMatchObject({ currentTime: 120, media: { duration: 6000 } })
    await wait(10)
    // The TV starts at the keyframe before 120 and its clock says so.
    expect(cast.status().position).toBeGreaterThanOrEqual(118.5)
    expect(cast.status().position).toBeLessThan(119.5)

    await cast.seek(3000)
    const second = loadUrl(f)
    expect(second).toMatch(/play\.mp4\?t=3000\.00$/)
    expect(tokenOf(second)).not.toBe(tokenOf(first))
    expect(cast.verify(tokenOf(first), '127.0.0.1')).not.toBeNull()
    expect(sent(f, 'SEEK')).toHaveLength(0)
  })

  it('copes with a TV whose clock restarts at 0 for each stream', async () => {
    const { f, cast } = await service('transcode')
    f.zeroClock = true
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 2000 })
    // Loading: the TV reads 0, and the film is where the cast started.
    expect(cast.status().position).toBe(2000)
    f.media!.currentTime = 12
    await wait(80)
    const p = cast.status().position!
    expect(p).toBeGreaterThanOrEqual(2012)
    expect(p).toBeLessThan(2014)
  })

  it('subtitles go to the TV as a WebVTT track, in film time like the stream', async () => {
    const { f, cast } = await service('remux')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 600, subtitle: { url: 'https://subs5.strem.io/en/x.srt', lang: 'en', label: 'English', offset: 0.5 } })
    const load = sent(f, 'LOAD')[0].data!
    const tracks = (load.media as { tracks: Array<{ trackContentId: string }> }).tracks
    expect(tracks[0].trackContentId).toMatch(/\/cast\/[A-Za-z0-9_-]{43}\/subs\.vtt$/)
    expect(load.activeTrackIds).toEqual([1])
    expect(cast.verify(tokenOf(tracks[0].trackContentId), '127.0.0.1')).toMatchObject({ subtitle: { url: 'https://subs5.strem.io/en/x.srt', offset: 0.5 } })
  })

  const SUBS = ['en/a', 'fr/b', 'es/c'].map(p => ({ url: `https://subs5.strem.io/${p}.srt`, lang: p.slice(0, 2), label: p }))
  const tracksOf = (f: FakeReceiver, i = -1) => (sent(f, 'LOAD').at(i)!.data!.media as { tracks?: Array<{ trackId: number; trackContentId: string }> }).tracks ?? []

  it('loads the viewer’s subtitles as tracks, each URL with its own token', async () => {
    const { f, cast } = await service('remux')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 1200, subtitle: { ...SUBS[1], offset: -1 }, subtitles: [...SUBS, SUBS[0]] })
    const tracks = tracksOf(f)
    expect(tracks.map(t => t.trackId)).toEqual([1, 2, 3])
    expect(sent(f, 'LOAD')[0].data!.activeTrackIds).toEqual([2])
    const grants = tracks.map(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1'))
    expect(grants.map(g => g?.subtitle?.url)).toEqual(SUBS.map(s => s.url))
    expect(grants.map(g => g?.subtitle?.offset ?? 0)).toEqual([0, -1, 0])
    expect(new Set(tracks.map(t => tokenOf(t.trackContentId))).size).toBe(3)
  })

  it('loads only a few tracks: the one showing and others in its language, in the player’s order', async () => {
    const many = ['en/1', 'fr/2', 'en/3', 'de/4', 'en/5', 'en/6', 'es/7'].map(p => ({ url: `https://subs5.strem.io/${p}.srt`, lang: p.slice(0, 2), label: p }))
    const { f, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0, subtitle: many[4], subtitles: many })
    const urls = tracksOf(f).map(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1')?.subtitle?.url)
    expect(urls).toEqual([many[0], many[2], many[4]].map(s => s.url))
    expect(sent(f, 'LOAD')[0].data!.activeTrackIds).toEqual([3])
    // Nothing showing: the first few in the first one's language.
    await cast.stop()
    const { f: g, cast: other } = await service('direct')
    await other.start({ deviceId: 'static-0', sessionId: SESSION, t: 0, subtitle: null, subtitles: many })
    expect(tracksOf(g).map(t => other.verify(tokenOf(t.trackContentId), '127.0.0.1')?.subtitle?.url)).toEqual([many[0], many[2], many[4]].map(s => s.url))
    expect(sent(g, 'LOAD')[0].data!.activeTrackIds).toEqual([])
  })

  it('turning subtitles off, on or to another language switches tracks on the TV, without a reload', async () => {
    const { f, cast } = await service('remux')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 1200, subtitle: null, subtitles: SUBS })
    expect(sent(f, 'LOAD')[0].data!.activeTrackIds).toEqual([])

    f.media!.currentTime = 1230
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
    // The new one and, with none other in German, the first others in the player's order (three at most).
    expect(tracksOf(f).map(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1')?.subtitle?.url)).toEqual([extra.url, SUBS[0].url, SUBS[1].url])
    expect(reload.activeTrackIds).toEqual([1])

    // Those now switch in place.
    await cast.setSubtitle(SUBS[1])
    expect(sent(f, 'EDIT_TRACKS_INFO').map(m => m.data!.activeTrackIds)).toEqual([[3]])
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

  it('reports the TV’s own volume and mute, which media statuses (the stream’s volume) don’t overwrite', async () => {
    const { f, cast } = await service('direct')
    f.volume = { level: 0.16, muted: false }
    expect(await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0 })).toMatchObject({ volume: 0.16, muted: false })
    expect(await cast.setVolume({ muted: true })).toMatchObject({ volume: 0.16, muted: true })
    f.broadcast(NS.media, f.mediaStatus())
    await wait(80)
    expect(cast.status()).toMatchObject({ volume: 0.16, muted: true })
    // The TV's own remote turns it up: the receiver says so.
    f.volume = { level: 0.3, muted: false }
    f.broadcast(NS.receiver, f.receiverStatus())
    await wait(20)
    expect(cast.status()).toMatchObject({ volume: 0.3, muted: false })
  })

  it('subtitle size: sent with the film and changed in place; a TV that refuses reloads', async () => {
    const { f, cast } = await service('direct')
    const s = await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 60, subtitle: SUBS[0], subtitles: SUBS, subtitleScale: 1.5 })
    expect(s.subtitleScale).toBe(1.5)
    expect((sent(f, 'LOAD')[0].data!.media as { textTrackStyle: { fontScale: number } }).textTrackStyle.fontScale).toBe(1.5)
    expect(s.subtitle).toBe(SUBS[0].url)
    // Answered at once; the TV gets it in turn (only the newest of quick taps).
    expect((await cast.setSubtitleScale(0.75)).subtitleScale).toBe(0.75)
    await wait(20)
    expect(sent(f, 'EDIT_TRACKS_INFO').at(-1)!.data).toMatchObject({ textTrackStyle: { fontScale: 0.75, edgeType: 'OUTLINE' } })
    expect(sent(f, 'LOAD')).toHaveLength(1)
    void cast.setSubtitleScale(0.875)
    void cast.setSubtitleScale(1)
    await wait(20)
    expect(sent(f, 'EDIT_TRACKS_INFO').map(m => (m.data!.textTrackStyle as { fontScale: number }).fontScale)).toEqual([0.75, 1])
    f.refuse.add('EDIT_TRACKS_INFO')
    await cast.setSubtitleScale(1.25)
    await wait(20)
    expect(sent(f, 'LOAD')).toHaveLength(2)
    expect((sent(f, 'LOAD')[1].data!.media as { textTrackStyle: { fontScale: number } }).textTrackStyle.fontScale).toBe(1.25)
  })

  it('a new timing offset for the subtitle showing reloads it, shifted', async () => {
    const { f, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 60, subtitle: SUBS[0], subtitles: SUBS })
    await cast.setSubtitle({ ...SUBS[0], offset: 1.5 }, SUBS)
    expect(sent(f, 'LOAD')).toHaveLength(2)
    const track = tracksOf(f).find(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1')?.subtitle?.url === SUBS[0].url)!
    expect(cast.verify(tokenOf(track.trackContentId), '127.0.0.1')!.subtitle).toMatchObject({ offset: 1.5 })
    expect(sent(f, 'LOAD')[1].data!.activeTrackIds).toEqual([track.trackId])
  })

  it('a subtitle the TV got empty (the service didn’t answer) reaches it once it downloads', async () => {
    let up = false
    const { f, cast } = await service('direct', { media: { subtitle: async () => { if (!up) throw new Error('timeout') } } })
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 60, subtitle: SUBS[0], subtitles: SUBS })
    // The one showing: once it downloads, the TV reloads from where it is and fetches it again.
    cast.subtitleUnavailable(SUBS[0].url)
    await wait(40)
    expect(sent(f, 'LOAD')).toHaveLength(1)
    up = true
    await wait(40)
    expect(sent(f, 'LOAD')).toHaveLength(2)
    // Another track it got empty: picking it reloads instead of showing the empty copy.
    const other = SUBS.find(s => tracksOf(f).some(t => cast.verify(tokenOf(t.trackContentId), '127.0.0.1')?.subtitle?.url === s.url) && s !== SUBS[0])!
    cast.subtitleUnavailable(other.url)
    await cast.setSubtitle(other, SUBS)
    expect(sent(f, 'LOAD')).toHaveLength(3)
    expect(sent(f, 'EDIT_TRACKS_INFO')).toHaveLength(0)
  })

  it('an episode shows on the TV as an episode of its show', async () => {
    const { f, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0, title: 'Panchayat · S2E3 Bhoot', streamId: 'tt12004706:2:3' })
    expect((sent(f, 'LOAD')[0].data!.media as { metadata: unknown }).metadata).toMatchObject({ metadataType: 2, seriesTitle: 'Panchayat', title: 'Bhoot', season: 2, episode: 3 })
  })

  it('a dropped connection is joined again: the TV plays on, nothing reloads, commands work', async () => {
    const { f, lan, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 300 })
    f.drop()
    await wait(5)
    expect(cast.status()).toMatchObject({ active: true, reconnecting: true })
    const paused = await cast.pause()
    expect(paused).toMatchObject({ active: true, state: 'paused' })
    expect(paused.reconnecting).toBeUndefined()
    expect(sent(f, 'LOAD')).toHaveLength(1)
    expect(sent(f, 'LAUNCH')).toHaveLength(1)
    expect(lan.held).toBe(1)
    // And again: each new connection is followed the same way.
    f.drop()
    await wait(60)
    expect((await cast.play()).state).toBe('playing')
  })

  it('gives up when the TV’s player is gone, and goes on when the film ended meanwhile', async () => {
    const { f, lan, cast } = await service('direct')
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 300 })
    f.app = null
    f.drop()
    await wait(80)
    expect(cast.status()).toMatchObject({ active: false, state: 'error', error: 'Lost the connection to Living Room TV' })
    expect(lan.held).toBe(0)

    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 5950 })
    f.media = null
    f.drop()
    await wait(80)
    expect(cast.status()).toMatchObject({ active: false, state: 'ended' })
  })

  it('saves the viewer’s progress while the TV plays, on pause, and at the end', async () => {
    const saved: CastProgress[] = []
    const { f, cast } = await service('direct', { onProgress: p => saved.push(p) })
    const source = { infoHash: 'a'.repeat(40), fileIdx: 0, type: 'movie' as const, imdbId: 'tt0056923' }
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 120, streamId: 'tt0056923', source, progress: { profile: 'P1', from: 'search' } })
    await cast.pause()
    expect(saved.at(-1)).toMatchObject({ profile: 'P1', from: 'search', type: 'movie', imdbId: 'tt0056923', streamId: 'tt0056923', duration: 6000 })
    expect(saved.at(-1)!.position).toBeGreaterThanOrEqual(120)
    f.media!.playerState = 'IDLE'
    f.broadcast(NS.media, { type: 'MEDIA_STATUS', requestId: 0, status: [{ ...f.media, currentTime: 0, idleReason: 'FINISHED' }] })
    await wait(50)
    expect(saved.at(-1)!.position).toBe(6000)

    // Without a profile (private mode), nothing is saved.
    saved.length = 0
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 120, streamId: 'tt0056923', source })
    await cast.pause()
    await cast.stop()
    expect(saved).toHaveLength(0)
  })

  it('when an episode ends, the next one plays on the same TV, and the phone can follow it', async () => {
    const NEXT = `${'b'.repeat(40)}-4`
    const opened: string[] = []
    const media: Partial<CastMedia> = {
      upNext: async id => (id === 'tt1:1:1' ? { streamId: 'tt1:1:2', name: 'Show · S1E2 Two' } : id === 'tt1:1:2' ? { streamId: 'tt1:1:3', name: 'Show · S1E3 Three' } : null),
      openNext: async (prev, up) => {
        opened.push(up.streamId)
        if (up.streamId === 'tt1:1:3') throw new Error('no sources for it yet')
        return { ...prev, sessionId: NEXT, t: 0, title: up.name, streamId: up.streamId, subtitle: SUBS[1], subtitles: SUBS, source: { infoHash: 'b'.repeat(40), fileIdx: 4, type: 'series', imdbId: 'tt1' } }
      },
    }
    const { f, cast } = await service('direct', { media })
    const source = { infoHash: 'a'.repeat(40), fileIdx: 0, type: 'series' as const, imdbId: 'tt1' }
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0, title: 'Show · S1E1 One', streamId: 'tt1:1:1', source, subtitle: SUBS[1], subtitles: SUBS, subtitleScale: 1.25 })
    await wait(10)
    expect(cast.status().upNext).toEqual({ streamId: 'tt1:1:2', name: 'Show · S1E2 Two' })
    const finish = () => {
      f.media!.playerState = 'IDLE'
      f.broadcast(NS.media, { type: 'MEDIA_STATUS', requestId: 0, status: [{ ...f.media, idleReason: 'FINISHED' }] })
    }
    finish()
    await wait(60)
    expect(cast.status()).toMatchObject({ active: true, sessionId: NEXT, streamId: 'tt1:1:2', title: 'Show · S1E2 Two', source: { infoHash: 'b'.repeat(40), fileIdx: 4 }, subtitleScale: 1.25 })
    expect(sent(f, 'LAUNCH')).toHaveLength(1)
    expect(sent(f, 'LOAD')).toHaveLength(2)
    expect(cast.verify(tokenOf(loadUrl(f)), '127.0.0.1')).toMatchObject({ sessionId: NEXT })
    expect((sent(f, 'LOAD')[1].data!.media as { metadata: unknown }).metadata).toMatchObject({ seriesTitle: 'Show', episode: 2 })
    await wait(10)
    expect(cast.status().upNext).toEqual({ streamId: 'tt1:1:3', name: 'Show · S1E3 Three' })

    // The next one can't be found: the cast ends and says why.
    finish()
    await wait(60)
    expect(opened).toEqual(['tt1:1:2', 'tt1:1:3'])
    expect(cast.status()).toMatchObject({ active: false, state: 'ended' })
    expect(cast.status().error).toMatch(/S1E3 Three next: no sources/)
  })

  it('"Not now" ends the cast with the episode; "Next episode" plays it at once', async () => {
    const media: Partial<CastMedia> = {
      upNext: async () => ({ streamId: 'tt1:1:2', name: 'Show · S1E2 Two' }),
      openNext: async (prev, up) => ({ ...prev, sessionId: `${'c'.repeat(40)}-1`, title: up.name, streamId: up.streamId }),
    }
    const { f, cast } = await service('direct', { media })
    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0, streamId: 'tt1:1:1' })
    await wait(10)
    expect((await cast.setUpNext(false)).upNext).toBeUndefined()
    f.media!.playerState = 'IDLE'
    f.broadcast(NS.media, { type: 'MEDIA_STATUS', requestId: 0, status: [{ ...f.media, idleReason: 'FINISHED' }] })
    await wait(50)
    expect(cast.status()).toMatchObject({ active: false, state: 'ended' })

    await cast.start({ deviceId: 'static-0', sessionId: SESSION, t: 0, streamId: 'tt1:1:1' })
    await wait(10)
    expect((await cast.playNext()).state).toBe('loading')
    await wait(30)
    expect(cast.status()).toMatchObject({ active: true, streamId: 'tt1:1:2', state: 'playing' })
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

  it('asks twice, in case the first question or its answer is lost on the Wi-Fi', async () => {
    const queries: Array<{ questions: Array<{ type: string }> }> = []
    const d = new CastDiscovery({ mdns: () => ({ on () {}, query (q: { questions: Array<{ name: string; type: string }> }) { queries.push(q) }, destroy () {} }) })
    await d.browse(60)
    expect(queries.filter(q => q.questions[0].type === 'PTR')).toHaveLength(2)
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
