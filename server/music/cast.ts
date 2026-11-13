import { randomBytes } from 'node:crypto'
import type { MusicCastMode, MusicCastRequest, MusicCastStatus, MusicTrack } from '../../shared/music.ts'
import { artSize } from '../../shared/music.ts'
import { isLoopback } from '../lan/net.ts'
import type { CastDevice, CastDiscovery } from '../cast/discovery.ts'
import { CastError, type MediaReceiver, type MediaStatus, MediaReceiver as Receiver } from '../cast/protocol.ts'
import type { MusicFiles } from './files.ts'

// Music on a TV (docs/adr/0010). The TV gets a queue and plays through it on its own: when a song finishes
// this computer sends the next one, so the phone that started it can be locked or put away. Three ways to
// show it: the song with its cover (audio), the lyrics picture (lyrics, drawn by ffmpeg; see render.ts),
// or the music video (video). The TV fetches /cast/m/<token>/…, with a token valid only for its own address.
// One cast at a time across films and music: starting one stops the other.

export type MusicCastState = NonNullable<MusicCastStatus['state']>

export interface MusicGrant {
  trackId: string
  mode: MusicCastMode
  /** Song time the stream starts at (lyrics pictures restart their clock at a seek). */
  from: number
  peer: string
  expires: number
}

interface Lan {
  holdForCast (): () => void
  refresh (): Promise<void>
  addressFor (peer: string): Promise<string | null>
  readonly port: number
}

export interface MusicCastOptions {
  discovery: CastDiscovery
  lan: Lan
  files: MusicFiles
  track: (id: string) => MusicTrack | null
  /** ffmpeg can draw the lyrics picture. */
  lyrics: boolean
  /** Stops a film cast first. */
  beforeStart?: () => Promise<unknown>
  connect?: (device: CastDevice) => Promise<MediaReceiver>
  log?: (msg: string) => void
  pollMs?: number
}

interface Session {
  device: CastDevice
  receiver: MediaReceiver
  lanAddress: string
  queue: string[]
  index: number
  mode: MusicCastMode
  token: string
  /** Song time where the TV's clock is 0 (lyrics pictures after a seek), else 0. */
  from: number
  duration: number
  last: { currentTime: number; playerState: string; at: number } | null
  state: MusicCastState
  volume: number | null
  muted: boolean
  note?: string
  error?: string
  /** A load is in progress: ignore the old song's FINISHED. */
  loading: boolean
  release: () => void
  poll?: NodeJS.Timeout
}

const TOKEN_TTL_MS = 6 * 3600_000
const DONE = ['ended', 'stopped', 'error']

export class MusicCast {
  private readonly o: MusicCastOptions
  private readonly log: (msg: string) => void
  private s: Session | null = null
  private readonly grants = new Map<string, MusicGrant>()
  private busy: Promise<unknown> = Promise.resolve()

  constructor (opts: MusicCastOptions) {
    this.o = opts
    this.log = opts.log ?? (() => {})
  }

  get modes (): MusicCastMode[] { return this.o.lyrics ? ['audio', 'lyrics', 'video'] : ['audio', 'video'] }

  get active (): boolean { return Boolean(this.s && !DONE.includes(this.s.state)) }

  verify (token: string, peer: string | undefined): MusicGrant | null {
    const g = this.grants.get(token)
    if (!g || g.expires < Date.now()) return null
    const ip = (peer ?? '').replace(/^::ffff:/i, '')
    if (ip !== g.peer && !isLoopback(peer)) return null
    return g
  }

  status (): MusicCastStatus {
    const s = this.s
    if (!s) return { active: false, modes: this.modes }
    const queue = s.queue.map(id => this.o.track(id)).filter((t): t is MusicTrack => Boolean(t))
    return {
      active: !DONE.includes(s.state),
      device: { id: s.device.id, name: s.device.name },
      mode: s.mode,
      state: s.state,
      queue,
      index: s.index,
      position: this.position(s),
      duration: s.duration,
      volume: s.volume,
      muted: s.muted,
      modes: this.modes,
      ...(s.error ? { error: s.error } : s.note ? { error: s.note } : {}),
    }
  }

  private serial<T> (fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn)
    this.busy = run.catch(() => {})
    return run
  }

  start (req: MusicCastRequest): Promise<MusicCastStatus> {
    return this.serial(async () => {
      await this.end('stopped', true)
      await this.o.beforeStart?.().catch(() => {})
      const device = this.o.discovery.get(req.deviceId)
      if (!device) throw new CastError('unknown_device', 'That TV isn’t on the network any more. Look for TVs again.')
      if (!this.o.track(req.queue[req.index] ?? '')) throw new CastError('no_media', 'Nothing to play')
      const release = this.o.lan.holdForCast()
      let receiver: MediaReceiver | null = null
      try {
        await this.o.lan.refresh()
        const lanAddress = await this.o.lan.addressFor(device.host)
        if (!lanAddress) throw new CastError('no_network', 'This computer isn’t on a home network, so the TV can’t reach it.')
        receiver = await (this.o.connect ?? (d => Receiver.connect(d.host, d.port)))(device)
        await receiver.launch()
        const s: Session = {
          device, receiver, lanAddress, queue: req.queue.slice(0, 500), index: req.index, mode: this.modes.includes(req.mode) ? req.mode : 'audio',
          token: '', from: 0, duration: 0, last: null, state: 'loading', volume: null, muted: false, loading: false, release,
        }
        this.s = s
        receiver.on('media', (m: MediaStatus) => { if (this.s === s) this.onMedia(s, m) })
        receiver.on('receiver', (r: { volume?: { level?: number; muted?: boolean } }) => {
          if (this.s !== s || !r.volume) return
          if (typeof r.volume.level === 'number') s.volume = r.volume.level
          if (typeof r.volume.muted === 'boolean') s.muted = r.volume.muted
        })
        receiver.on('close', (err?: Error) => {
          if (this.s !== s || DONE.includes(s.state)) return
          this.log(`music cast: ${s.device.name} closed: ${err?.message ?? 'no reason'}`)
          void this.end(err && (err as CastError).code !== 'replaced' ? 'error' : 'stopped', false, err?.message)
        })
        await this.load(s, s.index, Math.max(0, req.t))
        s.poll = setInterval(() => {
          if (this.s !== s || s.receiver.closed || s.loading) return
          s.receiver.getStatus().then(m => { if (m) this.onMedia(s, m) }).catch(() => {})
        }, this.o.pollMs ?? 4000)
        s.poll.unref()
        this.log(`music cast: playing on ${device.name} (${s.mode})`)
        return this.status()
      } catch (err) {
        receiver?.close()
        if (this.s?.receiver === receiver) this.s = null
        release()
        throw err
      }
    })
  }

  /** The phone added songs (a radio keeps going) or reordered: same song keeps playing. */
  setQueue (queue: string[], index?: number): MusicCastStatus {
    const s = this.s
    if (!s || DONE.includes(s.state)) throw new CastError('not_casting', 'Nothing is casting')
    const current = s.queue[s.index]
    s.queue = queue.slice(0, 500)
    const at = index ?? s.queue.indexOf(current)
    s.index = at >= 0 ? at : 0
    return this.status()
  }

  control (action: string, arg: { t?: number; index?: number; level?: number; muted?: boolean; mode?: MusicCastMode }): Promise<MusicCastStatus> {
    return this.serial(async () => {
      const s = this.s
      if (!s || DONE.includes(s.state)) throw new CastError('not_casting', 'Nothing is casting')
      switch (action) {
        case 'play': this.onMedia(s, await s.receiver.play()); break
        case 'pause': this.onMedia(s, await s.receiver.pause()); break
        case 'next':
          if (s.index + 1 < s.queue.length) await this.load(s, s.index + 1, 0)
          break
        case 'prev':
          if (this.position(s) > 5 || s.index === 0) await this.seekTo(s, 0)
          else await this.load(s, s.index - 1, 0)
          break
        case 'jump':
          if (Number.isInteger(arg.index) && arg.index! >= 0 && arg.index! < s.queue.length) await this.load(s, arg.index!, 0)
          break
        case 'seek': await this.seekTo(s, arg.t ?? 0); break
        case 'mode':
          if (arg.mode && this.modes.includes(arg.mode) && arg.mode !== s.mode) {
            s.mode = arg.mode
            await this.load(s, s.index, arg.mode === 'video' ? 0 : this.position(s))
          }
          break
        case 'volume': {
          const v: { level?: number; muted?: boolean } = {}
          if (typeof arg.level === 'number') v.level = arg.level
          if (typeof arg.muted === 'boolean') v.muted = arg.muted
          await s.receiver.setVolume(v)
          if (v.level !== undefined) s.volume = v.level
          if (v.muted !== undefined) s.muted = v.muted
          break
        }
      }
      return this.status()
    })
  }

  stop (): Promise<MusicCastStatus> {
    return this.serial(async () => {
      const last = this.status()
      await this.end('stopped', true)
      return last.device ? { ...last, active: false, state: 'stopped' } : last
    })
  }

  shutdown (): void {
    const s = this.s
    if (!s) return
    clearInterval(s.poll)
    s.receiver.close()
    s.release()
    this.grants.clear()
  }

  private async seekTo (s: Session, t: number): Promise<void> {
    const to = Math.max(0, Math.min(t, Math.max(0, s.duration - 1)))
    if (s.mode === 'lyrics') return this.load(s, s.index, to)
    s.last = { currentTime: to, playerState: 'BUFFERING', at: Date.now() }
    this.onMedia(s, await s.receiver.seek(to))
  }

  /** Points the TV at song `index` from `t` seconds, getting its file ready first. */
  private async load (s: Session, index: number, t: number): Promise<void> {
    const track = this.o.track(s.queue[index])
    if (!track) throw new CastError('no_media', 'That song is gone')
    s.loading = true
    s.index = index
    s.state = 'loading'
    s.note = undefined
    s.last = { currentTime: 0, playerState: 'BUFFERING', at: Date.now() }
    try {
      let mode = s.mode
      await this.o.files.ensure(track, 'audio').catch(err => { throw new CastError('no_media', (err as Error).message) })
      if (mode === 'video') {
        const ok = await this.o.files.ensure(track, 'video').then(() => true, () => false)
        if (!ok) {
          mode = this.o.lyrics ? 'lyrics' : 'audio'
          s.note = `No music video for “${track.title}”, so the ${mode === 'lyrics' ? 'lyrics are' : 'song is'} showing instead.`
        }
      }
      const file = this.o.files.saved(track.id, mode === 'video' ? 'video' : 'audio')
      s.duration = file?.duration ?? track.duration
      const from = mode === 'lyrics' ? Math.max(0, Math.min(t, s.duration - 1)) : 0
      const token = randomBytes(32).toString('base64url')
      this.grants.set(token, { trackId: track.id, mode, from, peer: s.device.host, expires: Date.now() + TOKEN_TTL_MS })
      const old = this.grants.get(s.token)
      if (old) old.expires = Math.min(old.expires, Date.now() + 30_000)
      s.token = token
      s.from = from
      const base = `http://${s.lanAddress}:${this.o.lan.port}/cast/m/${token}`
      const status = await s.receiver.load({
        contentId: mode === 'audio' ? `${base}/audio.m4a` : mode === 'video' ? `${base}/video.mp4` : `${base}/lyrics.mp4`,
        contentType: mode === 'audio' ? 'audio/mp4' : 'video/mp4',
        currentTime: mode === 'lyrics' ? 0 : t,
        duration: Math.max(1, s.duration - from),
        title: track.title,
        image: artSize(track.album?.cover ?? track.artist.picture, 1000),
        music: { artist: track.credit ?? track.artist.name, album: track.album?.title },
      })
      s.last = { currentTime: status.currentTime, playerState: status.playerState, at: Date.now() }
      s.state = status.playerState === 'PLAYING' ? 'playing' : 'buffering'
      // The next song gets ready while this one plays.
      const next = this.o.track(s.queue[index + 1] ?? '')
      if (next) {
        this.o.files.ensure(next, 'audio').catch(() => {})
        if (mode === 'video') this.o.files.ensure(next, 'video').catch(() => {})
      }
    } finally {
      s.loading = false
    }
  }

  private onMedia (s: Session, m: MediaStatus | null): void {
    if (!m) return
    s.last = { currentTime: m.currentTime, playerState: m.playerState, at: Date.now() }
    if (m.volume) {
      if (typeof m.volume.level === 'number') s.volume = m.volume.level
      if (typeof m.volume.muted === 'boolean') s.muted = m.volume.muted
    }
    switch (m.playerState) {
      case 'PLAYING': s.state = 'playing'; break
      case 'PAUSED': s.state = 'paused'; break
      case 'BUFFERING': s.state = 'buffering'; break
      case 'IDLE':
        if (s.loading) break
        if (m.idleReason === 'FINISHED') {
          s.loading = true
          void this.serial(async () => {
            if (this.s !== s || DONE.includes(s.state)) return
            if (s.index + 1 < s.queue.length) {
              await this.load(s, s.index + 1, 0).catch(err => {
                this.log(`music cast: next song failed: ${(err as Error).message}`)
                s.note = (err as Error).message
                // Try the one after, once.
                return s.index + 1 < s.queue.length ? this.load(s, s.index + 1, 0).catch(() => this.end('ended', false)) : this.end('ended', false)
              })
            } else await this.end('ended', false)
          }).finally(() => { s.loading = false })
        } else if (m.idleReason === 'ERROR') void this.end('error', false, 'The TV couldn’t play this song.')
        else if (m.idleReason === 'CANCELLED') void this.end('stopped', false)
        break
    }
  }

  private position (s: Session): number {
    if (!s.last) return s.from
    const running = s.last.playerState === 'PLAYING' ? (Date.now() - s.last.at) / 1000 : 0
    const pos = s.from + s.last.currentTime + running
    return Math.max(0, Math.min(pos, s.duration || pos))
  }

  private async end (state: MusicCastState, quitTv: boolean, error?: string): Promise<void> {
    const s = this.s
    if (!s) return
    if (!DONE.includes(s.state)) this.log(`music cast: ended on ${s.device.name} (${state}${error ? `: ${error}` : ''}${quitTv ? ', asked to stop' : ''})`)
    if (!DONE.includes(s.state)) {
      s.last = s.last && { ...s.last, currentTime: this.position(s) - s.from, at: Date.now(), playerState: 'IDLE' }
      s.state = state
      if (error) s.error = error
    }
    clearInterval(s.poll)
    this.grants.clear()
    s.release()
    if (quitTv && !s.receiver.closed) await s.receiver.stopApp().catch(() => {})
    else s.receiver.close()
    if (quitTv) this.s = null
  }
}
