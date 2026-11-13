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
//
// Subtitles: the TV is loaded with a few of the viewer's subtitles as text tracks (the one showing and others
// in its language; MAX_TEXT_TRACKS), each at /cast/<its own token>/subs.vtt. Turning subtitles off and on, or
// to one of those, only switches tracks on the TV (EDIT_TRACKS_INFO); another one reloads from where it is.

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

/** How many of the player's subtitles a cast is told about (the choices to pick tracks from). */
export const MAX_SUBTITLE_CHOICES = 40

/**
 * Subtitle tracks the TV is loaded with. Few: an LG fetches every track as soon as the film loads, and forty
 * of them (each a download from the subtitle service, which then refused with HTTP 429) left it buffering and
 * deaf to the computer within minutes. The one showing and others in its language switch in place.
 */
export const MAX_TEXT_TRACKS = 3

export interface StartCast {
  deviceId: string
  sessionId: string
  /** Film time to start at. */
  t: number
  audio?: number
  /** The subtitle showing from the start. */
  subtitle?: CastSubtitle | null
  /** Every subtitle the viewer can switch to while casting (the player's list). */
  subtitles?: CastSubtitle[]
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
  /** Settles once `origin` is known (the keyframe lookup), so a subtitle shown later is shifted right. */
  originReady: Promise<void>
  startedAt: number
  /** The stream's token; `tokens` also holds one per subtitle track. */
  token: string
  tokens: string[]
  /** The subtitle tracks the TV was loaded with, and the one showing (an index), if any. */
  tracks: CastSubtitle[]
  activeTrack: number | null
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
/** How long a load (or a subtitle switch) waits for where a copied stream really starts. */
const ORIGIN_WAIT_MS = 10_000

const later = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(resolve, ms, value).unref())

/**
 * The tracks for the TV: at most MAX_TEXT_TRACKS of the viewer's choices (one per URL): `showing`, then
 * others in its language (or, with none showing, the first choice's), kept in the player's order. Returns
 * them and the index of `showing`.
 */
export function subtitleTracks (showing: CastSubtitle | null, choices: CastSubtitle[]): { tracks: CastSubtitle[]; activeTrack: number | null } {
  const all: CastSubtitle[] = []
  const seen = new Set<string>()
  for (const s of choices) {
    if (seen.has(s.url)) continue
    seen.add(s.url)
    all.push(showing && s.url === showing.url ? showing : s)
  }
  if (showing && !seen.has(showing.url)) all.unshift(showing)
  const lang = showing?.lang ?? all[0]?.lang
  const rank = (s: CastSubtitle) => (s === showing ? 0 : s.lang === lang ? 1 : 2)
  const picked = new Set([...all].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_TEXT_TRACKS))
  const tracks = all.filter(s => picked.has(s))
  return { tracks, activeTrack: showing ? tracks.indexOf(showing) : null }
}

export interface CastOptions {
  discovery: CastDiscovery
  lan: Lan
  media: CastMedia
  connect?: (device: CastDevice) => Promise<MediaReceiver>
  log?: (msg: string) => void
  pollMs?: number
  /** Called before a cast starts: music casting stops, one cast at a time. */
  beforeStart?: () => Promise<unknown>
}

export class CastService {
  private readonly opts: CastOptions
  private readonly log: (msg: string) => void
  private current: Cast | null = null
  private readonly tokens = new Map<string, CastToken>()
  private busy: Promise<unknown> = Promise.resolve()
  /** The newest seek; queued older ones are skipped (each would reload a converted stream for nothing). */
  private seekGen = 0
  private lastSeek: Promise<CastStatus> | null = null

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
      await this.opts.beforeStart?.().catch(() => {})
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
          origin: 0, clockBase: null, originReady: Promise.resolve(), startedAt: 0, token: '', tokens: [],
          ...subtitleTracks(req.subtitle ?? null, req.subtitles ?? []),
          last: null, state: 'loading', volume: null, muted: false, release,
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

  /**
   * Film time `t`. Direct play seeks on the TV; a converted stream is reloaded from `t`. Seeks that queue
   * up behind one in progress (taps on "forward 10 s") collapse into the newest, which they all answer with.
   */
  seek (t: number): Promise<CastStatus> {
    const gen = ++this.seekGen
    const run = this.command(async c => {
      if (gen !== this.seekGen) return null
      const to = Math.max(0, Math.min(t, Math.max(0, c.duration - 1)))
      if (c.plan.mode === 'direct') {
        c.last = { currentTime: to, playerState: 'BUFFERING', at: Date.now() }
        return c.receiver.seek(to)
      }
      await this.load(c, to)
      return null
    })
    this.lastSeek = run
    return run.then(s => (gen === this.seekGen ? s : this.lastSeek!.catch(() => this.status())))
  }

  /**
   * Shows `sub` on the TV, or no subtitles. One of the tracks the TV was loaded with switches in place and
   * playback carries on; any other subtitle (or a TV that refuses the switch) reloads from where it is, with
   * `choices` (the player's list) as the new tracks.
   */
  setSubtitle (sub: CastSubtitle | null, choices?: CastSubtitle[]): Promise<CastStatus> {
    return this.command(async c => {
      if (!sub && c.tracks.length === 0) return null
      const index = sub ? c.tracks.findIndex(s => s.url === sub.url) : -1
      if (!sub || index >= 0) {
        // The keyframe lookup is usually done long before; the TV fetches the track as soon as it shows.
        if (sub) await Promise.race([c.originReady, later(ORIGIN_WAIT_MS, undefined)])
        try {
          const status = await c.receiver.showTextTrack(sub ? index : null)
          c.activeTrack = sub ? index : null
          return status
        } catch (err) {
          if (!(err instanceof CastError) || !['invalid', 'no_media'].includes(err.code)) throw err
          this.log(`cast: ${c.device.name} refused a subtitle switch (${err.message}); reloading`)
          c.activeTrack = sub ? index : null
        }
      } else {
        Object.assign(c, subtitleTracks(sub, choices?.length ? choices : c.tracks))
      }
      await this.load(c, Math.max(0, Math.min(this.position(c), Math.max(0, c.duration - 1))))
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

  /** Whether a film is casting now. */
  get casting (): boolean {
    return Boolean(this.current && !['ended', 'stopped', 'error'].includes(this.current.state))
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

  /** Points the TV at the stream from film time `t`, with the subtitle tracks. */
  private async load (c: Cast, t: number): Promise<void> {
    const direct = c.plan.mode === 'direct'
    const expires = Date.now() + TOKEN_TTL_MS
    // One token for the stream and one per subtitle track: the TV is handed a URL for each.
    const grant = (subtitle: CastSubtitle | null): [string, CastToken] =>
      [randomBytes(32).toString('base64url'), { sessionId: c.req.sessionId, plan: c.plan, origin: direct ? 0 : t, subtitle, peer: c.device.host, expires }]
    const stream = grant(null)
    const tracks = c.tracks.map(grant)
    const grants = [stream, ...tracks]
    const token = stream[0]
    const setOrigin = (origin: number) => {
      for (const [, g] of grants) g.origin = origin
      if (c.token === token) c.origin = origin
    }
    // Copied video starts at the keyframe before t. Subtitles must be shifted by the real start, so find it
    // first when one shows from the start; otherwise it arrives while the TV buffers.
    const start = !direct && c.plan.copyVideo && t > 0 ? this.opts.media.streamStart(c.req.sessionId, t).catch(() => t) : null
    let originReady = Promise.resolve()
    if (start && c.activeTrack !== null) setOrigin(await Promise.race([start, later(ORIGIN_WAIT_MS, t)]))
    else if (start) originReady = start.then(setOrigin)
    const now = Date.now()
    for (const [k, g] of this.tokens) if (g.expires < now) this.tokens.delete(k)
    for (const k of c.tokens) {
      const previous = this.tokens.get(k)
      if (previous) previous.expires = Math.min(previous.expires, now + TOKEN_GRACE_MS)
    }
    for (const [k, g] of grants) this.tokens.set(k, g)

    const url = (k: string) => `http://${c.lanAddress}:${this.opts.lan.port}/cast/${k}`
    c.token = token
    c.tokens = grants.map(([k]) => k)
    c.origin = stream[1].origin
    c.originReady = originReady
    c.clockBase = direct ? 0 : null
    c.startedAt = t
    c.last = { currentTime: direct ? t : 0, playerState: 'BUFFERING', at: Date.now() }
    c.state = 'loading'
    const [title, ...rest] = (c.req.title ?? '').split(' · ')
    const status = await c.receiver.load({
      contentId: direct ? `${url(token)}/raw` : `${url(token)}/play.mp4?t=${t.toFixed(2)}`,
      contentType: direct ? c.contentType : 'video/mp4',
      currentTime: direct ? t : 0,
      duration: Math.max(1, c.duration - (direct ? 0 : c.origin)),
      title: title || undefined,
      subtitle: rest.join(' · ') || undefined,
      image: c.req.image,
      textTracks: tracks.map(([k, g]) => ({ url: `${url(k)}/subs.vtt`, language: g.subtitle!.lang, name: g.subtitle!.label })),
      activeTextTrack: c.activeTrack,
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
    if (wasLive) this.log(`cast: ended on ${c.device.name} (${state}${error ? `: ${error}` : ''}${quitTv ? ', asked to stop' : ''})`)
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
