import { randomBytes } from 'node:crypto'
import type { PlaybackMode, PlaybackPlan } from '../../shared/types.ts'
import { isLoopback } from '../lan/net.ts'
import type { CastDevice, CastDiscovery } from './discovery.ts'
import { CastError, type MediaReceiver, type MediaStatus, MediaReceiver as Receiver } from './protocol.ts'

// One cast at a time, from this computer to a TV. The TV fetches the video from this computer's address on
// the home network, at /cast/<token>/…: it has no cookie, so the URL carries a random token, valid only for
// the TV's own IP address and only while this cast runs (a reload for a seek makes a new one and keeps the
// old one alive for 30 s). Any page of the app (on the computer or a connected phone) can start, follow and
// control it through /api/cast.

export type CastState = 'connecting' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'stopped' | 'error'

export interface CastStatus {
  active: boolean
  device?: { id: string; name: string }
  sessionId?: string
  /** The title as the player shows it, so a second screen can show what's on. */
  title?: string
  streamId?: string
  state?: CastState
  /** Film time in seconds. */
  position?: number
  duration?: number
  volume?: number | null
  muted?: boolean
  mode?: PlaybackMode
  error?: string
}

export interface CastSubtitle { url: string; label?: string; lang?: string; offset?: number }

export interface StartCast {
  deviceId: string
  sessionId: string
  /** Film time to start at. */
  t: number
  audio?: number
  subtitle?: CastSubtitle | null
  title?: string
  streamId?: string
  image?: string
}

/** What the cast needs from the playback pipeline (server/index.ts provides it). */
export interface CastMedia {
  /** The cast plan for a session (H.264 + AAC in MP4) and what's needed to build URLs. */
  plan (sessionId: string, audio?: number): Promise<{ plan: PlaybackPlan; durationSec: number; contentType: string }>
  /** Where a copied-video stream that was asked for at `t` really starts (the keyframe before t). */
  streamStart (sessionId: string, t: number): Promise<number>
}

export interface CastToken {
  sessionId: string
  plan: PlaybackPlan
  /** Film time at the start of the stream's own clock (for subtitles). */
  origin: number
  subtitle: CastSubtitle | null
  /** The TV's address: only it may use the token. */
  peer: string
  expires: number
}

interface Lan {
  holdForCast (): () => void
  refresh (): Promise<void>
  addressFor (peer: string): Promise<string | null>
  readonly port: number
}

interface Cast {
  device: CastDevice
  receiver: MediaReceiver
  req: StartCast
  plan: PlaybackPlan
  duration: number
  contentType: string
  lanAddress: string
  origin: number
  /** 0 when the TV reports film time, `origin` when its clock restarts at 0 for each stream; null until known. */
  clockBase: number | null
  startedAt: number
  token: string
  last: { currentTime: number; playerState: string; at: number } | null
  state: CastState
  volume: number | null
  muted: boolean
  error?: string
  release: () => void
  poll?: NodeJS.Timeout
}

const TOKEN_TTL_MS = 12 * 3600_000
const TOKEN_GRACE_MS = 30_000

export interface CastOptions {
  discovery: CastDiscovery
  lan: Lan
  media: CastMedia
  connect?: (device: CastDevice) => Promise<MediaReceiver>
  log?: (msg: string) => void
  pollMs?: number
}

export class CastService {
  private readonly opts: CastOptions
  private readonly log: (msg: string) => void
  private current: Cast | null = null
  private readonly tokens = new Map<string, CastToken>()
  private busy: Promise<unknown> = Promise.resolve()

  constructor (opts: CastOptions) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
  }

  devices (refresh: boolean): Promise<CastDevice[]> {
    return refresh ? this.opts.discovery.browse() : Promise.resolve(this.opts.discovery.list())
  }

  /** The token's grant, if it's live and `peer` is the TV it was made for (or this computer, for testing). */
  verify (token: string, peer: string | undefined): CastToken | null {
    const t = this.tokens.get(token)
    if (!t || t.expires < Date.now()) return null
    const ip = (peer ?? '').replace(/^::ffff:/i, '')
    if (ip !== t.peer && !isLoopback(peer)) return null
    return t
  }

  status (): CastStatus {
    const c = this.current
    if (!c) return { active: false }
    return {
      active: !['ended', 'stopped', 'error'].includes(c.state),
      device: { id: c.device.id, name: c.device.name },
      sessionId: c.req.sessionId,
      title: c.req.title,
      streamId: c.req.streamId,
      state: c.state,
      position: this.position(c),
      duration: c.duration,
      volume: c.volume,
      muted: c.muted,
      mode: c.plan.mode,
      ...(c.error ? { error: c.error } : {}),
    }
  }

  /** Commands run one at a time, so a seek can't race a stop. */
  private serial<T> (fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn)
    this.busy = run.catch(() => {})
    return run
  }

  start (req: StartCast): Promise<CastStatus> {
    return this.serial(async () => {
      await this.end('stopped', true)
      const device = this.opts.discovery.get(req.deviceId)
      if (!device) throw new CastError('unknown_device', 'That TV isn’t on the network any more. Look for TVs again.')
      const release = this.opts.lan.holdForCast()
      let receiver: MediaReceiver | null = null
      try {
        await this.opts.lan.refresh()
        const lanAddress = await this.opts.lan.addressFor(device.host)
        if (!lanAddress) throw new CastError('no_network', 'This computer isn’t on a home network, so the TV can’t reach it.')
        const { plan, durationSec, contentType } = await this.opts.media.plan(req.sessionId, req.audio)
        receiver = await (this.opts.connect ?? (d => Receiver.connect(d.host, d.port)))(device)
        await receiver.launch()
        const cast: Cast = {
          device, receiver, req, plan, duration: durationSec, contentType, lanAddress,
          origin: 0, clockBase: null, startedAt: 0, token: '', last: null, state: 'loading', volume: null, muted: false, release,
        }
        this.current = cast
        receiver.on('media', (s: MediaStatus) => { if (this.current === cast) this.onMedia(cast, s) })
        receiver.on('receiver', (s: { volume?: { level?: number; muted?: boolean } }) => {
          if (this.current !== cast || !s.volume) return
          if (typeof s.volume.level === 'number') cast.volume = s.volume.level
          if (typeof s.volume.muted === 'boolean') cast.muted = s.volume.muted
        })
        receiver.on('close', (err?: Error) => {
          if (this.current !== cast || ['ended', 'stopped', 'error'].includes(cast.state)) return
          this.log(`cast: ${cast.device.name} closed: ${err?.message ?? 'no reason'}`)
          void this.end(err && (err as CastError).code !== 'replaced' ? 'error' : 'stopped', false, err?.message)
        })
        await this.load(cast, Math.max(0, req.t))
        cast.poll = setInterval(() => {
          if (this.current !== cast || cast.receiver.closed) return
          cast.receiver.getStatus().then(s => { if (s) this.onMedia(cast, s) }).catch(() => {})
        }, this.opts.pollMs ?? 5000)
        cast.poll.unref()
        this.log(`cast: playing on ${device.name} (${plan.mode})`)
        return this.status()
      } catch (err) {
        receiver?.close()
        if (this.current?.receiver === receiver) this.current = null
        release()
        throw err
      }
    })
  }

  play (): Promise<CastStatus> { return this.command(c => c.receiver.play()) }
  pause (): Promise<CastStatus> { return this.command(c => c.receiver.pause()) }

  /** Film time `t`. Direct play seeks on the TV; a converted stream is reloaded from `t`. */
  seek (t: number): Promise<CastStatus> {
    return this.command(async c => {
      const to = Math.max(0, Math.min(t, Math.max(0, c.duration - 1)))
      if (c.plan.mode === 'direct') {
        c.last = { currentTime: to, playerState: 'BUFFERING', at: Date.now() }
        return c.receiver.seek(to)
      }
      await this.load(c, to)
      return null
    })
  }

  setVolume (v: { level?: number; muted?: boolean }): Promise<CastStatus> {
    return this.command(async c => {
      await c.receiver.setVolume(v)
      if (typeof v.level === 'number') c.volume = v.level
      if (typeof v.muted === 'boolean') c.muted = v.muted
      return null
    })
  }

  /** Quits the player on the TV. Returns where it was, so the page can carry on from there. */
  stop (): Promise<CastStatus> {
    return this.serial(async () => {
      const last = this.status()
      await this.end('stopped', true)
      return last.device ? { ...last, active: false, state: 'stopped' } : last
    })
  }

  shutdown (): void {
    const c = this.current
    if (!c) return
    clearInterval(c.poll)
    c.receiver.close()
    c.release()
    this.tokens.clear()
  }

  private command (fn: (c: Cast) => Promise<MediaStatus | null>): Promise<CastStatus> {
    return this.serial(async () => {
      const c = this.current
      if (!c || ['ended', 'stopped', 'error'].includes(c.state)) throw new CastError('not_casting', 'Nothing is casting')
      const s = await fn(c)
      if (s) this.onMedia(c, s)
      return this.status()
    })
  }

  /** Points the TV at the stream from film time `t`. */
  private async load (c: Cast, t: number): Promise<void> {
    const token = randomBytes(32).toString('base64url')
    const direct = c.plan.mode === 'direct'
    const grant: CastToken = { sessionId: c.req.sessionId, plan: c.plan, origin: direct ? 0 : t, subtitle: c.req.subtitle ?? null, peer: c.device.host, expires: Date.now() + TOKEN_TTL_MS }
    // Copied video starts at the keyframe before t. Subtitles must be shifted by the real start, so find it
    // first when there are subtitles; otherwise it arrives while the TV buffers.
    const start = !direct && c.plan.copyVideo && t > 0 ? this.opts.media.streamStart(c.req.sessionId, t).catch(() => t) : null
    if (start && grant.subtitle) grant.origin = await Promise.race([start, new Promise<number>(resolve => setTimeout(resolve, 10_000, t))])
    else if (start) void start.then(s => { grant.origin = s; if (c.token === token) c.origin = s })
    this.tokens.set(token, grant)
    const previous = this.tokens.get(c.token)
    if (previous) previous.expires = Math.min(previous.expires, Date.now() + TOKEN_GRACE_MS)

    const base = `http://${c.lanAddress}:${this.opts.lan.port}/cast/${token}`
    c.token = token
    c.origin = grant.origin
    c.clockBase = direct ? 0 : null
    c.startedAt = t
    c.last = { currentTime: direct ? t : 0, playerState: 'BUFFERING', at: Date.now() }
    c.state = 'loading'
    const [title, ...rest] = (c.req.title ?? '').split(' · ')
    const status = await c.receiver.load({
      contentId: direct ? `${base}/raw` : `${base}/play.mp4?t=${t.toFixed(2)}`,
      contentType: direct ? c.contentType : 'video/mp4',
      currentTime: direct ? t : 0,
      duration: Math.max(1, c.duration - (direct ? 0 : grant.origin)),
      title: title || undefined,
      subtitle: rest.join(' · ') || undefined,
      image: c.req.image,
      textTrack: grant.subtitle ? { url: `${base}/subs.vtt`, language: grant.subtitle.lang, name: grant.subtitle.label } : undefined,
    })
    this.onMedia(c, status)
  }

  private onMedia (c: Cast, s: MediaStatus): void {
    const at = Date.now()
    if (c.clockBase === null && s.currentTime > 0) {
      // Most receivers restart the clock at 0 for each progressive stream; some report the file's own
      // timestamps (film time, since the server keeps them). Tell them apart on the first real reading.
      c.clockBase = c.origin > 30 && s.currentTime >= c.origin - 10 ? 0 : c.origin
    }
    c.last = { currentTime: s.currentTime, playerState: s.playerState, at }
    if (s.volume) {
      if (typeof s.volume.level === 'number') c.volume = s.volume.level
      if (typeof s.volume.muted === 'boolean') c.muted = s.volume.muted
    }
    switch (s.playerState) {
      case 'PLAYING': c.state = 'playing'; break
      case 'PAUSED': c.state = 'paused'; break
      case 'BUFFERING': c.state = 'buffering'; break
      case 'IDLE':
        if (s.idleReason === 'FINISHED') void this.end('ended', false)
        else if (s.idleReason === 'ERROR') void this.end('error', false, 'The TV couldn’t play this stream.')
        else if (s.idleReason === 'CANCELLED') void this.end('stopped', false)
        break
    }
  }

  private position (c: Cast): number {
    if (!c.last) return c.startedAt
    const base = c.clockBase ?? c.origin
    const running = c.last.playerState === 'PLAYING' ? (Date.now() - c.last.at) / 1000 : 0
    const pos = base + c.last.currentTime + running
    return Math.max(0, Math.min(pos, c.duration || pos))
  }

  /** Finishes the current cast: optionally quits the TV's player, releases the LAN listener and tokens. */
  private async end (state: CastState, quitTv: boolean, error?: string): Promise<void> {
    const c = this.current
    if (!c) return
    const wasLive = !['ended', 'stopped', 'error'].includes(c.state)
    if (wasLive) {
      c.last = c.last && { ...c.last, currentTime: this.position(c) - (c.clockBase ?? c.origin), at: Date.now(), playerState: 'IDLE' }
      c.state = state
      if (error) c.error = error
    }
    clearInterval(c.poll)
    for (const [k, t] of this.tokens) if (t.sessionId === c.req.sessionId) this.tokens.delete(k)
    c.release()
    if (quitTv && !c.receiver.closed) await c.receiver.stopApp().catch(() => {})
    else c.receiver.close()
    if (quitTv) this.current = null
  }
}
