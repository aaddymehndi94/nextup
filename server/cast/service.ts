import { randomBytes } from 'node:crypto'
import type { MediaType, PlaybackMode, PlaybackPlan } from '../../shared/types.ts'
import { isLoopback } from '../lan/net.ts'
import type { CastDevice, CastDiscovery } from './discovery.ts'
import { CastError, type MediaReceiver, type MediaStatus, MediaReceiver as Receiver, REJOIN_DELAYS_MS, rejoinPlayer } from './protocol.ts'

// One cast at a time, from this computer to a TV. The TV fetches the video from this computer's address on
// the home network, at /cast/<token>/…: it has no cookie, so the URL carries a random token, valid only for
// the TV's own IP address and only while this cast runs (a reload for a seek makes a new one and keeps the
// old one alive for 30 s). Any page of the app (on the computer or a connected phone) can start, follow and
// control it through /api/cast.
//
// Subtitles: the TV is loaded with a few of the viewer's subtitles as text tracks (the one showing and others
// in its language; MAX_TEXT_TRACKS), each at /cast/<its own token>/subs.vtt. Turning subtitles off and on, or
// to one of those, only switches tracks on the TV (EDIT_TRACKS_INFO); another one reloads from where it is. Their
// size follows the player's A−/A+ (textTrackStyle, changed in place); a new timing offset reloads from where it is.
//
// The computer holds the cast, so a phone can sleep or leave: it saves the viewer's progress while the TV plays
// (onProgress), goes on to the next episode when one ends (CastMedia.openNext), and when the connection to the TV
// drops (a Wi-Fi blip), joins the TV's player again: the TV keeps playing meanwhile.

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
  /** Subtitle size on the TV, times its own. */
  subtitleScale?: number
  /** The subtitle showing on the TV (its URL), or null for none. */
  subtitle?: string | null
  /** The file playing, so a phone can open it (after the computer went on to the next episode). */
  source?: CastSource
  /** The episode that follows when this one ends, unless turned off for this cast. */
  upNext?: UpNext
  /** The connection to the TV dropped and the computer is joining its player again. */
  reconnecting?: boolean
}

export interface CastSubtitle { url: string; label?: string; lang?: string; offset?: number }

/** A file in a torrent, and the title it is. */
export interface CastSource { infoHash: string; fileIdx?: number; fileName?: string; type: MediaType; imdbId: string }

/** An episode to play next: its stream id (tt…:season:episode) and name as the player shows it ("Show · S1E3 Name"). */
export interface UpNext { streamId: string; name: string }

/** Where the TV is in a title, for the viewer's Continue watching. */
export interface CastProgress { profile: string; type: MediaType; imdbId: string; streamId: string; from?: string; position: number; duration: number }

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
  /** Subtitle size (the player's A−/A+), times the TV's own. */
  subtitleScale?: number
  /** The file, so the computer can find the next episode and a phone can follow. */
  source?: CastSource
  /** Whose progress this is (not in private mode). */
  progress?: { profile: string; from?: string }
  /** Private mode: the next episode opens privately too. */
  private?: boolean
}

/** What the cast needs from the playback pipeline (server/index.ts provides it). */
export interface CastMedia {
  /** The cast plan for a session (H.264 + AAC in MP4) and what's needed to build URLs. */
  plan (sessionId: string, audio?: number): Promise<{ plan: PlaybackPlan; durationSec: number; contentType: string }>
  /** Downloads a subtitle (to try one again that the TV got empty). */
  subtitle? (url: string): Promise<unknown>
  /** The episode after `streamId` (an episode), if it's out. */
  upNext? (streamId: string): Promise<UpNext | null>
  /**
   * Gets episode `up` ready to follow `prev` on the TV: a source (the same torrent when it has it), its torrent
   * session and subtitles in the language that was showing. Returns the cast for it.
   */
  openNext? (prev: StartCast, up: UpNext): Promise<StartCast>
}

export interface CastToken {
  sessionId: string
  plan: PlaybackPlan
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
  /** Film time at the TV's clock 0: 0 (streams carry film time), `startedAt` for a TV that restarts its clock anyway; null until known. */
  clockBase: number | null
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
  subtitleScale: number
  upNext: UpNext | null
  /** "Not now" on the phone: this episode ends the cast. */
  upNextOff: boolean
  /** Going on to the next episode. */
  continuing: boolean
  /** Settles when a dropped connection is joined again (or given up on). */
  rejoining: Promise<void> | null
  progressAt: number
  /** Subtitles the TV was given empty (the download failed) since the last load: switching to one reloads. */
  emptyTracks: Set<string>
  /** Subtitles being tried again. */
  retrying: Set<string>
}

const ENDED: CastState[] = ['ended', 'stopped', 'error']
const isOver = (c: { state: CastState }) => ENDED.includes(c.state)
/** Progress is saved this often while the TV plays (and on pause, seek, the end and stop). */
const PROGRESS_MS = 15_000
/** How long the next episode may take to get ready (a new torrent finds peers and the file's start). */
const NEXT_WAIT_MS = 4 * 60_000
const EPISODE = /^tt\d+:\d+:\d+$/
const SCALE = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0.5, Math.min(2, v)) : 1)

/** After a subtitle the TV got empty: when to try downloading it again. */
const SUBTITLE_RETRY_MS = [20_000, 40_000, 60_000, 120_000]

const TOKEN_TTL_MS = 12 * 3600_000
const TOKEN_GRACE_MS = 30_000
/** How long a load (or a subtitle switch) waits for where a copied stream really starts. */

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
  /** Saves where the TV is in a title (every 15 s while playing, and on pause, seek, the end and stop). */
  onProgress?: (p: CastProgress) => void
  /** Waits between tries to join the TV again after the connection dropped (tests make them short). */
  rejoinDelays?: number[]
  /** Waits between tries of a subtitle the TV got empty (tests make them short). */
  subtitleRetryMs?: number[]
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
      active: !isOver(c),
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
      subtitleScale: c.subtitleScale,
      subtitle: c.activeTrack !== null ? c.tracks[c.activeTrack]?.url ?? null : null,
      ...(c.req.source ? { source: c.req.source } : {}),
      ...(c.upNext && !c.upNextOff ? { upNext: c.upNext } : {}),
      ...(c.rejoining ? { reconnecting: true } : {}),
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
      // Not seen lately (nexttupp just started, or an answer was lost): look once more before giving up.
      const device = this.opts.discovery.get(req.deviceId) ?? (await this.opts.discovery.browse()).find(d => d.id === req.deviceId)
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
          clockBase: null, startedAt: 0, token: '', tokens: [],
          ...subtitleTracks(req.subtitle ?? null, req.subtitles ?? []),
          last: null, state: 'loading', volume: null, muted: false, release,
          subtitleScale: SCALE(req.subtitleScale), upNext: null, upNextOff: false, continuing: false, rejoining: null, progressAt: 0,
          emptyTracks: new Set(), retrying: new Set(),
        }
        this.current = cast
        this.wire(cast, receiver)
        await this.load(cast, Math.max(0, req.t))
        cast.poll = setInterval(() => {
          if (this.current !== cast || cast.receiver.closed) return
          cast.receiver.getStatus().then(s => { if (s && this.current === cast) this.onMedia(cast, s) }).catch(() => {})
          this.progress(cast)
        }, this.opts.pollMs ?? 5000)
        cast.poll.unref()
        this.log(`cast: playing on ${device.name} (${plan.mode})`)
        void this.lookUpNext(cast)
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
      c.progressAt = 0
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
      // The same subtitle at a new timing offset: the TV has the track as it was, so it reloads with the new one.
      const retimed = sub !== null && index >= 0 && (c.tracks[index].offset ?? 0) !== (sub.offset ?? 0)
      // One the TV was given empty (its download failed then) reloads, so the TV fetches it again.
      if (retimed || (sub && index >= 0 && c.emptyTracks.has(sub.url))) {
        c.tracks[index] = sub!
        c.activeTrack = index
      } else if (!sub || index >= 0) {
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

  /**
   * Subtitle size on the TV (times its own), changed in place; a TV that refuses reloads from where it is. Answered
   * at once: behind a reload still waiting for the torrent, the TV gets the newest size when it's ready.
   */
  setSubtitleScale (scale: number): Promise<CastStatus> {
    const c = this.current
    if (!c || isOver(c)) return Promise.reject(new CastError('not_casting', 'Nothing is casting'))
    const want = SCALE(scale)
    c.subtitleScale = want
    this.command(async now => {
      if (now !== c || c.subtitleScale !== want || c.tracks.length === 0) return null
      try {
        return await c.receiver.setTextScale(c.subtitleScale)
      } catch (err) {
        if (!(err instanceof CastError) || !['invalid', 'no_media'].includes(err.code)) throw err
        this.log(`cast: ${c.device.name} refused a subtitle size (${err.message}); reloading`)
      }
      if (c.activeTrack !== null) await this.load(c, Math.max(0, Math.min(this.position(c), Math.max(0, c.duration - 1))))
      return null
    }).catch(err => this.log(`cast: subtitle size not applied (${(err as Error).message})`))
    return Promise.resolve(this.status())
  }

  /**
   * The TV was given `url` empty (the subtitle service didn't answer). Tries it again for a few minutes; once it
   * downloads, the TV gets it: at once if it's the one showing (a reload from where it is), else when picked.
   */
  subtitleUnavailable (url: string): void {
    const c = this.current
    if (!c || isOver(c)) return
    c.emptyTracks.add(url)
    if (!this.opts.media.subtitle || c.retrying.has(url)) return
    c.retrying.add(url)
    void (async () => {
      for (const ms of this.opts.subtitleRetryMs ?? SUBTITLE_RETRY_MS) {
        await later(ms, undefined)
        if (this.current !== c || isOver(c) || !c.emptyTracks.has(url)) return
        if (!(await this.opts.media.subtitle!(url).then(() => true, () => false))) continue
        if (c.activeTrack === null || c.tracks[c.activeTrack]?.url !== url) return
        this.log(`cast: a subtitle downloads now; giving it to ${c.device.name}`)
        await this.command(async now => {
          if (now !== c || c.activeTrack === null || c.tracks[c.activeTrack]?.url !== url) return null
          await this.load(c, Math.max(0, Math.min(this.position(c), Math.max(0, c.duration - 1))))
          return null
        }).catch(() => {})
        return
      }
    })().finally(() => c.retrying.delete(url))
  }

  /** Whether the next episode follows on the TV when this one ends ("Not now" on the phone turns it off). */
  setUpNext (on: boolean): Promise<CastStatus> {
    return this.command(async c => { c.upNextOff = !on; return null })
  }

  /** Goes on to the next episode now. Answers at once, loading; the status follows as it gets ready. */
  async playNext (): Promise<CastStatus> {
    const c = this.current
    if (!c || isOver(c)) throw new CastError('not_casting', 'Nothing is casting')
    if (!c.upNext || !this.opts.media.openNext) throw new CastError('invalid', 'There’s no next episode to play')
    if (!c.continuing) {
      this.progress(c, true)
      void this.continueWith(c, c.upNext)
    }
    return this.status()
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
    return Boolean(this.current && !isOver(this.current))
  }

  /** Quits the player on the TV. Returns where it was, so the page can carry on from there. */
  stop (): Promise<CastStatus> {
    const run = async () => {
      const last = this.status()
      await this.end('stopped', true)
      return last.device ? { ...last, active: false, state: 'stopped' as const, reconnecting: undefined } : last
    }
    // Commands wait for a dropped connection to come back; Stop doesn't.
    return this.current?.rejoining ? run() : this.serial(run)
  }

  shutdown (): void {
    const c = this.current
    if (!c) return
    // Over, so closing the connection isn't taken for a drop to rejoin. (The TV plays on what it has buffered.)
    if (!isOver(c)) c.state = 'stopped'
    clearInterval(c.poll)
    c.receiver.close()
    c.release()
    this.tokens.clear()
  }

  private command (fn: (c: Cast) => Promise<MediaStatus | null>): Promise<CastStatus> {
    return this.serial(async () => {
      // While the connection is being joined again, a tap on the phone waits for it instead of failing.
      if (this.current?.rejoining) await this.current.rejoining
      const c = this.current
      if (!c || isOver(c)) throw new CastError('not_casting', 'Nothing is casting')
      const s = await fn(c)
      if (s && this.current === c) this.onMedia(c, s)
      return this.status()
    })
  }

  /** Follows one connection to the TV: its statuses, and what to do when it closes. */
  private wire (c: Cast, receiver: MediaReceiver): void {
    c.receiver = receiver
    if (typeof receiver.volume?.level === 'number') c.volume = receiver.volume.level
    if (typeof receiver.volume?.muted === 'boolean') c.muted = receiver.volume.muted
    const mine = () => this.current === c && c.receiver === receiver
    receiver.on('media', (s: MediaStatus) => { if (mine()) this.onMedia(c, s) })
    receiver.on('receiver', (s: { volume?: { level?: number; muted?: boolean } }) => {
      if (!mine() || !s.volume) return
      if (typeof s.volume.level === 'number') c.volume = s.volume.level
      if (typeof s.volume.muted === 'boolean') c.muted = s.volume.muted
    })
    receiver.on('close', (err?: Error) => {
      if (!mine() || isOver(c)) return
      this.log(`cast: ${c.device.name} closed: ${err?.message ?? 'no reason'}`)
      // Someone started something else on the TV, or quit the player there: the cast is over.
      if ((err as CastError | undefined)?.code === 'replaced') { void this.end('stopped', false, err!.message); return }
      void this.rejoin(c, receiver)
    })
  }

  /**
   * The connection dropped but the TV is probably still playing: join its player again, for about a minute.
   * Meanwhile the status says so (reconnecting) and commands wait.
   */
  private rejoin (c: Cast, old: MediaReceiver): Promise<void> {
    if (c.rejoining) return c.rejoining
    const app = old.appSession
    const media = old.mediaSessionId
    const connect = () => {
      const d = this.opts.discovery.get(c.device.id) ?? c.device
      return (this.opts.connect ?? (x => Receiver.connect(x.host, x.port)))(d)
    }
    const still = () => this.current === c && !isOver(c)
    c.rejoining = (async () => {
      const back = app ? await rejoinPlayer(connect, app, media, still, this.opts.rejoinDelays ?? REJOIN_DELAYS_MS) : null
      c.rejoining = null
      if (!still()) { back?.receiver.close(); return }
      if (!back) { await this.end('error', false, `Lost the connection to ${c.device.name}`); return }
      this.wire(c, back.receiver)
      this.log(`cast: joined ${c.device.name} again`)
      if (back.status) { this.onMedia(c, back.status); return }
      // The player is there but the film isn't: it finished (or failed) while the connection was down.
      if (c.duration - this.position(c) < 120) void this.finished(c)
      else await this.end('error', false, `${c.device.name} stopped playing`)
    })()
    return c.rejoining
  }

  /** Points the TV at the stream from film time `t`, with the subtitle tracks. */
  private async load (c: Cast, t: number): Promise<void> {
    const direct = c.plan.mode === 'direct'
    const expires = Date.now() + TOKEN_TTL_MS
    // One token for the stream and one per subtitle track: the TV is handed a URL for each.
    const grant = (subtitle: CastSubtitle | null): [string, CastToken] =>
      [randomBytes(32).toString('base64url'), { sessionId: c.req.sessionId, plan: c.plan, subtitle, peer: c.device.host, expires }]
    const stream = grant(null)
    const tracks = c.tracks.map(grant)
    const grants = [stream, ...tracks]
    const token = stream[0]
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
    // The TV fetches every track again for this load.
    c.emptyTracks.clear()
    c.clockBase = direct ? 0 : null
    c.startedAt = t
    c.last = { currentTime: t, playerState: 'BUFFERING', at: Date.now() }
    c.state = 'loading'
    const [title, ...rest] = (c.req.title ?? '').split(' · ')
    // "Show · S1E3 Name": the TV shows it as an episode of the show. A converted stream carries film time and
    // the film's length (server/playback/fmp4.ts), so the TV's clock and seek bar read where the film is; it
    // starts at the keyframe before t, as the TV can't skip ahead in a stream that is still being made.
    const ep = /^S(\d+)E(\d+)\s*(.*)$/.exec(rest.join(' · '))
    const status = await c.receiver.load({
      contentId: direct ? `${url(token)}/raw` : `${url(token)}/play.mp4?t=${t.toFixed(2)}`,
      contentType: direct ? c.contentType : 'video/mp4',
      currentTime: t,
      duration: Math.max(1, c.duration),
      title: (ep ? ep[3] || `Episode ${ep[2]}` : title) || undefined,
      subtitle: (ep ? `${title} · S${ep[1]} E${ep[2]}` : rest.join(' · ')) || undefined,
      show: ep ? { series: title, season: Number(ep[1]), episode: Number(ep[2]) } : undefined,
      image: c.req.image,
      textTracks: tracks.map(([k, g]) => ({ url: `${url(k)}/subs.vtt`, language: g.subtitle!.lang, name: g.subtitle!.label })),
      activeTextTrack: c.activeTrack,
      textScale: c.subtitleScale,
    })
    this.onMedia(c, status)
  }

  private onMedia (c: Cast, s: MediaStatus): void {
    const at = Date.now()
    if (c.clockBase === null && s.currentTime > 0) {
      // A TV that restarts its clock at 0 despite the stream's film time reads far below where it started
      // (then film time is off by at most the keyframe distance).
      c.clockBase = c.startedAt > 30 && s.currentTime < c.startedAt - 15 ? c.startedAt : 0
    }
    // An idle player's clock says nothing about where the film was (some report 0 once it has finished).
    // (Its volume is the stream's, always 1; the TV's own comes with receiver statuses.)
    if (s.playerState !== 'IDLE') c.last = { currentTime: s.currentTime, playerState: s.playerState, at }
    if (c.continuing) return
    switch (s.playerState) {
      case 'PLAYING': c.state = 'playing'; break
      case 'PAUSED':
        if (c.state !== 'paused') { c.state = 'paused'; this.progress(c, true) }
        break
      case 'BUFFERING': c.state = 'buffering'; break
      case 'IDLE':
        if (s.idleReason === 'FINISHED') void this.finished(c)
        else if (s.idleReason === 'ERROR') void this.end('error', false, 'The TV couldn’t play this stream.')
        else if (s.idleReason === 'CANCELLED') void this.end('stopped', false)
        break
    }
  }

  /** The TV played to the end: on to the next episode, if there is one and it wasn't turned off. */
  private async finished (c: Cast): Promise<void> {
    if (c.continuing || isOver(c)) return
    c.last = { currentTime: c.duration - (c.clockBase ?? 0), playerState: 'IDLE', at: Date.now() }
    this.progress(c, true)
    const up = c.upNextOff ? null : c.upNext
    if (!up || !this.opts.media.openNext) { await this.end('ended', false); return }
    await this.continueWith(c, up)
  }

  /**
   * Plays episode `up` on the same TV, without starting its player again. Ends the cast if it can't. Getting the
   * episode ready (a torrent, maybe a new one) happens outside the command queue, so Stop still answers at once.
   */
  private async continueWith (c: Cast, up: UpNext): Promise<void> {
    c.continuing = true
    c.state = 'loading'
    const from = c.req.streamId
    try {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('it took too long to start')), NEXT_WAIT_MS); timer.unref() })
      const ready = (async () => {
        const req = await this.opts.media.openNext!(c.req, up)
        return { req, ...(await this.opts.media.plan(req.sessionId, undefined)) }
      })()
      const { req, plan, durationSec, contentType } = await Promise.race([ready, timeout]).finally(() => clearTimeout(timer))
      await this.serial(async () => {
        if (this.current !== c || isOver(c)) return
        this.expireTokens(c)
        Object.assign(c, {
          req: { ...req, deviceId: c.req.deviceId, subtitleScale: c.subtitleScale },
          plan, duration: durationSec, contentType,
          ...subtitleTracks(req.subtitle ?? null, req.subtitles ?? []),
          upNext: null, upNextOff: false, progressAt: 0,
        })
        c.continuing = false
        await this.load(c, 0)
        this.log(`cast: ${from ?? 'an episode'} finished on ${c.device.name}; playing ${req.title ?? req.streamId}`)
        void this.lookUpNext(c)
      })
    } catch (err) {
      if (this.current !== c || isOver(c)) return
      this.log(`cast: couldn’t go on to ${up.name}: ${(err as Error).message}`)
      c.continuing = false
      await this.end('ended', false, `Couldn’t play ${up.name.split(' · ').slice(1).join(' · ') || up.name} next: ${(err as Error).message}`)
    } finally {
      c.continuing = false
    }
  }

  /** Finds the episode after the one playing, so the phone can show it and it can follow. */
  private async lookUpNext (c: Cast): Promise<void> {
    const id = c.req.streamId
    if (!id || !EPISODE.test(id) || !this.opts.media.upNext || !this.opts.media.openNext) return
    const up = await this.opts.media.upNext(id).catch(() => null)
    if (this.current === c && c.req.streamId === id) c.upNext = up
  }

  /** Saves the viewer's progress (every PROGRESS_MS while playing, or now). */
  private progress (c: Cast, now = false): void {
    const p = c.req.progress
    const src = c.req.source
    if (!p || !src || !c.req.streamId || !this.opts.onProgress || !c.duration || !c.last) return
    if (!now && (c.state !== 'playing' || Date.now() - c.progressAt < PROGRESS_MS)) return
    c.progressAt = Date.now()
    try {
      this.opts.onProgress({ profile: p.profile, from: p.from, type: src.type, imdbId: src.imdbId, streamId: c.req.streamId, position: this.position(c), duration: c.duration })
    } catch (err) { this.log(`cast: progress not saved (${(err as Error).message})`) }
  }

  /** The tokens of what played so far stop working soon (a TV may still be reading the end). */
  private expireTokens (c: Cast): void {
    const soon = Date.now() + TOKEN_GRACE_MS
    for (const [, t] of this.tokens) if (t.sessionId === c.req.sessionId) t.expires = Math.min(t.expires, soon)
  }

  private position (c: Cast): number {
    // Until the TV's clock first moves (it reads 0 while it loads), the film is where the cast started.
    if (!c.last || c.clockBase === null) return c.startedAt
    const base = c.clockBase
    const running = c.last.playerState === 'PLAYING' ? (Date.now() - c.last.at) / 1000 : 0
    const pos = base + c.last.currentTime + running
    return Math.max(0, Math.min(pos, c.duration || pos))
  }

  /** Finishes the current cast: optionally quits the TV's player, releases the LAN listener and tokens. */
  private async end (state: CastState, quitTv: boolean, error?: string): Promise<void> {
    const c = this.current
    if (!c) return
    const wasLive = !isOver(c)
    if (wasLive && c.last && c.state !== 'loading') this.progress(c, true)
    if (wasLive) this.log(`cast: ended on ${c.device.name} (${state}${error ? `: ${error}` : ''}${quitTv ? ', asked to stop' : ''})`)
    if (wasLive) {
      c.last = c.last && { ...c.last, currentTime: this.position(c) - (c.clockBase ?? 0), at: Date.now(), playerState: 'IDLE' }
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
