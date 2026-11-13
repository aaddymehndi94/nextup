import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'

// Google Cast v2, as much of it as a sender needs to play a URL on the Default Media Receiver.
//
// The wire format is a TLS stream (port 8009, self-signed certificate) of frames: a 4-byte big-endian
// length and a protobuf `CastMessage`. Every message here carries a JSON string payload. Written in-house
// because the npm packages for this (castv2, castv2-client) are unmaintained since 2016–2019 and load their
// .proto file from disk at runtime, which the desktop app's single-file server bundle can't provide; the one
// message type takes 60 lines to encode by hand.
//
//   message CastMessage {
//     required ProtocolVersion protocol_version = 1;  // CASTV2_1_0 = 0
//     required string source_id = 2;
//     required string destination_id = 3;
//     required string namespace = 4;
//     required PayloadType payload_type = 5;          // STRING = 0, BINARY = 1
//     optional string payload_utf8 = 6;
//     optional bytes payload_binary = 7;
//   }

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
} as const

/** The Default Media Receiver: Google's own player app on every Chromecast and Google/Android TV. */
export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'
const MAX_FRAME = 64 * 1024

export interface CastMessage {
  source: string
  destination: string
  namespace: string
  /** The JSON payload, parsed. Binary payloads (device auth) aren't used and come through as null. */
  data: Record<string, unknown> | null
}

// ---- Protobuf -------------------------------------------------------------------------------

function varint (n: number): number[] {
  const out: number[] = []
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
  out.push(n)
  return out
}

function field (num: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from([(num << 3) | 2, ...varint(bytes.length)]), bytes])
}

/** One frame: length prefix + CastMessage with a UTF-8 payload. */
export function encodeFrame (m: { source: string; destination: string; namespace: string; payload: string }): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]), // protocol_version = CASTV2_1_0
    field(2, m.source),
    field(3, m.destination),
    field(4, m.namespace),
    Buffer.from([0x28, 0x00]), // payload_type = STRING
    field(6, m.payload),
  ])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

/** Decodes one CastMessage body (without the length prefix). Unknown fields are skipped. */
export function decodeMessage (buf: Buffer): CastMessage {
  const strings: Record<number, string> = {}
  let i = 0
  const readVarint = () => {
    let n = 0
    let shift = 0
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint')
      const b = buf[i++]
      n += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return n
      shift += 7
      if (shift > 49) throw new Error('varint too long')
    }
  }
  while (i < buf.length) {
    const key = readVarint()
    const num = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) readVarint()
    else if (wire === 2) {
      const len = readVarint()
      if (i + len > buf.length) throw new Error('truncated field')
      strings[num] = buf.subarray(i, i + len).toString('utf8')
      i += len
    } else throw new Error(`unsupported wire type ${wire}`)
  }
  let data: Record<string, unknown> | null = null
  if (strings[6] !== undefined) {
    try { data = JSON.parse(strings[6]) as Record<string, unknown> } catch { data = null }
  }
  return { source: strings[2] ?? '', destination: strings[3] ?? '', namespace: strings[4] ?? '', data }
}

/** Splits a byte stream into frames. Returns the leftover bytes. */
export function readFrames (buf: Buffer, onFrame: (body: Buffer) => void): Buffer {
  let off = 0
  while (buf.length - off >= 4) {
    const len = buf.readUInt32BE(off)
    if (len > MAX_FRAME) throw new Error(`cast frame of ${len} bytes is too large`)
    if (buf.length - off - 4 < len) break
    onFrame(buf.subarray(off + 4, off + 4 + len))
    off += 4 + len
  }
  return buf.subarray(off)
}

// ---- Channel --------------------------------------------------------------------------------

export class CastError extends Error {
  readonly code: string
  constructor (code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface ChannelOptions {
  /** How the socket is made; tests pass an in-memory pair. */
  socket?: () => Duplex
  heartbeatMs?: number
  /** No message at all from the receiver for this long ends the connection. */
  timeoutMs?: number
  requestTimeoutMs?: number
}

/**
 * One connection to a cast device: frames, PING/PONG, and request/response matching by requestId.
 * Emits 'message' (CastMessage) and 'close' (Error | undefined).
 */
export class CastChannel extends EventEmitter {
  readonly sender = `sender-${Math.floor(Math.random() * 1e9)}`
  private readonly socket: Duplex
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (m: CastMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private heartbeat?: NodeJS.Timeout
  private lastHeard = Date.now()
  private closed = false
  private readonly requestTimeoutMs: number

  constructor (socket: Duplex, opts: ChannelOptions = {}) {
    super()
    this.socket = socket
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      try {
        this.buffer = readFrames(this.buffer, body => this.receive(decodeMessage(body)))
      } catch (err) { this.close(err as Error) }
    })
    socket.on('error', err => this.close(err))
    socket.on('close', () => this.close())
    const heartbeatMs = opts.heartbeatMs ?? 5000
    const timeoutMs = opts.timeoutMs ?? 20_000
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastHeard > timeoutMs) return this.close(new CastError('timeout', 'The TV stopped answering'))
      this.send(NS.heartbeat, 'receiver-0', { type: 'PING' })
    }, heartbeatMs)
    this.heartbeat.unref()
  }

  /** TLS to host:port; Cast devices use self-signed certificates, so there's nothing to verify against. */
  static connect (host: string, port: number, opts: ChannelOptions = {}): Promise<CastChannel> {
    return new Promise((resolve, reject) => {
      const socket = opts.socket ? opts.socket() : tlsConnect({ host, port, rejectUnauthorized: false })
      const fail = (err: Error) => reject(new CastError('unreachable', `Can’t reach the TV (${err.message})`))
      const timer = setTimeout(() => { socket.destroy(); fail(new Error('timed out')) }, 8000)
      const ready = () => {
        clearTimeout(timer)
        socket.off('error', fail)
        resolve(new CastChannel(socket, opts))
      }
      socket.once('error', err => { clearTimeout(timer); fail(err) })
      if (opts.socket) setImmediate(ready)
      else socket.once('secureConnect', ready)
    })
  }

  get isClosed (): boolean { return this.closed }

  send (namespace: string, destination: string, data: Record<string, unknown>): void {
    if (this.closed) throw new CastError('closed', 'The connection to the TV has closed')
    this.socket.write(encodeFrame({ source: this.sender, destination, namespace, payload: JSON.stringify(data) }))
  }

  /** Sends with a fresh requestId and waits for the reply that carries it. */
  request (namespace: string, destination: string, data: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<CastMessage> {
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new CastError('timeout', `The TV didn’t answer ${String(data.type)}`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      try { this.send(namespace, destination, { ...data, requestId }) } catch (err) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(err as Error)
      }
    })
  }

  close (err?: Error): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err ?? new CastError('closed', 'The connection to the TV has closed')) }
    this.pending.clear()
    this.socket.destroy()
    this.emit('close', err)
  }

  private receive (m: CastMessage): void {
    this.lastHeard = Date.now()
    if (m.namespace === NS.heartbeat) {
      if (m.data?.type === 'PING') this.send(NS.heartbeat, m.source, { type: 'PONG' })
      return
    }
    if (m.namespace === NS.connection && m.data?.type === 'CLOSE' && m.source === 'receiver-0') {
      this.close(new CastError('closed', 'The TV closed the connection'))
      return
    }
    const id = typeof m.data?.requestId === 'number' ? m.data.requestId : 0
    const waiting = id ? this.pending.get(id) : undefined
    if (waiting) {
      clearTimeout(waiting.timer)
      this.pending.delete(id)
      waiting.resolve(m)
    }
    this.emit('message', m)
  }
}

// ---- Default Media Receiver ----------------------------------------------------------------

export interface MediaStatus {
  mediaSessionId: number
  playerState: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING' | string
  idleReason?: 'CANCELLED' | 'INTERRUPTED' | 'FINISHED' | 'ERROR' | string
  currentTime: number
  volume?: { level?: number; muted?: boolean }
}

export interface ReceiverStatus {
  volume?: { level?: number; muted?: boolean }
  applications?: Array<{ appId: string; sessionId: string; transportId: string; displayName?: string }>
}

export interface TextTrack { url: string; language?: string; name?: string }

export interface LoadRequest {
  contentId: string
  contentType: string
  /** Seconds into the URL's own timeline. */
  currentTime: number
  duration?: number
  title?: string
  subtitle?: string
  image?: string
  /**
   * WebVTT subtitle tracks the viewer can switch between without reloading (see showTextTrack). The
   * receiver fetches a track's URL when it's shown.
   */
  textTracks?: TextTrack[]
  /** Which of `textTracks` shows from the start (its index), if any. */
  activeTextTrack?: number | null
  /** A song: the TV shows it as music (artist and album under the title, the cover large). */
  music?: { artist?: string; album?: string }
}

/** Track ids on the receiver: 1, 2, … for textTracks[0], [1], … */
const textTrackId = (index: number) => index + 1

/**
 * The Default Media Receiver on one device: launch it, load a URL, and control playback. Emits
 * 'media' (MediaStatus), 'receiver' (ReceiverStatus) and 'close' (Error | undefined): the TV went away,
 * or another sender took over the TV.
 */
export class MediaReceiver extends EventEmitter {
  private readonly channel: CastChannel
  private transportId: string | null = null
  private appSessionId: string | null = null
  mediaSessionId: number | null = null

  constructor (channel: CastChannel) {
    super()
    this.channel = channel
    channel.on('message', (m: CastMessage) => this.onMessage(m))
    channel.on('close', (err?: Error) => this.emit('close', err))
  }

  static async connect (host: string, port: number, opts: ChannelOptions = {}): Promise<MediaReceiver> {
    const channel = await CastChannel.connect(host, port, opts)
    channel.send(NS.connection, 'receiver-0', { type: 'CONNECT' })
    return new MediaReceiver(channel)
  }

  get closed (): boolean { return this.channel.isClosed }

  /** Starts (or joins) the Default Media Receiver and connects to it. */
  async launch (): Promise<void> {
    const r = await this.channel.request(NS.receiver, 'receiver-0', { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER }, 20_000)
    if (r.data?.type === 'LAUNCH_ERROR') throw new CastError('launch_failed', `The TV couldn’t start its player (${String(r.data.reason ?? 'unknown reason')})`)
    const app = (r.data?.status as ReceiverStatus | undefined)?.applications?.find(a => a.appId === DEFAULT_MEDIA_RECEIVER)
    if (!app) throw new CastError('launch_failed', 'The TV didn’t start its player')
    this.transportId = app.transportId
    this.appSessionId = app.sessionId
    this.channel.send(NS.connection, app.transportId, { type: 'CONNECT' })
  }

  async load (req: LoadRequest): Promise<MediaStatus> {
    const media: Record<string, unknown> = {
      contentId: req.contentId,
      contentUrl: req.contentId,
      contentType: req.contentType,
      streamType: 'BUFFERED',
      metadata: req.music
        ? { metadataType: 3, title: req.title, artist: req.music.artist, albumName: req.music.album, images: req.image ? [{ url: req.image }] : [] }
        : { metadataType: 0, title: req.title, subtitle: req.subtitle, images: req.image ? [{ url: req.image }] : [] },
    }
    if (req.duration) media.duration = req.duration
    const body: Record<string, unknown> = { type: 'LOAD', media, autoplay: true, currentTime: req.currentTime }
    if (req.textTracks?.length) {
      media.tracks = req.textTracks.map((t, i) => ({ trackId: textTrackId(i), type: 'TEXT', subtype: 'SUBTITLES', trackContentId: t.url, trackContentType: 'text/vtt', language: t.language, name: t.name }))
      media.textTrackStyle = { backgroundColor: '#00000000', edgeType: 'OUTLINE', edgeColor: '#000000FF', foregroundColor: '#FFFFFFFF', fontScale: 1 }
      // Always said, even when none shows: left out, a receiver may pick one by its own language setting.
      const active = req.activeTextTrack
      body.activeTrackIds = typeof active === 'number' && req.textTracks[active] ? [textTrackId(active)] : []
    }
    const r = await this.channel.request(NS.media, this.transport(), body, 30_000)
    const status = this.mediaFrom(r)
    if (!status) {
      const type = String(r.data?.type ?? '')
      throw new CastError('load_failed', type === 'LOAD_CANCELLED' ? 'Another load replaced this one' : `The TV couldn’t play this stream (${type || 'no status'})`)
    }
    return status
  }

  play () { return this.mediaCommand('PLAY') }
  pause () { return this.mediaCommand('PAUSE') }
  seek (currentTime: number) { return this.mediaCommand('SEEK', { currentTime, resumeState: 'PLAYBACK_START' }) }
  stopMedia () { return this.mediaCommand('STOP') }
  /** Shows text track `index` of the loaded media (or none), in place: playback carries on where it is. */
  showTextTrack (index: number | null) { return this.mediaCommand('EDIT_TRACKS_INFO', { activeTrackIds: index === null ? [] : [textTrackId(index)] }) }
  getStatus () { return this.mediaCommand('GET_STATUS') }

  async setVolume (volume: { level?: number; muted?: boolean }): Promise<void> {
    await this.channel.request(NS.receiver, 'receiver-0', { type: 'SET_VOLUME', volume })
  }

  /** Quits the player on the TV (back to its home screen or ambient mode) and closes the connection. */
  async stopApp (): Promise<void> {
    if (this.appSessionId) await this.channel.request(NS.receiver, 'receiver-0', { type: 'STOP', sessionId: this.appSessionId }, 5000).catch(() => {})
    this.close()
  }

  close (): void {
    if (this.channel.isClosed) return
    try { if (this.transportId) this.channel.send(NS.connection, this.transportId, { type: 'CLOSE' }) } catch { /* closing anyway */ }
    this.channel.close()
  }

  private transport (): string {
    if (!this.transportId) throw new CastError('not_launched', 'The TV’s player isn’t running')
    return this.transportId
  }

  private async mediaCommand (type: string, extra: Record<string, unknown> = {}): Promise<MediaStatus | null> {
    const body: Record<string, unknown> = { type, ...extra }
    if (type !== 'GET_STATUS') {
      if (this.mediaSessionId === null) throw new CastError('no_media', 'Nothing is playing on the TV')
      body.mediaSessionId = this.mediaSessionId
    }
    const r = await this.channel.request(NS.media, this.transport(), body)
    if (r.data?.type === 'INVALID_REQUEST' || r.data?.type === 'INVALID_PLAYER_STATE') {
      throw new CastError('invalid', `The TV refused ${type} (${String(r.data.reason ?? r.data.type)})`)
    }
    return this.mediaFrom(r)
  }

  private mediaFrom (m: CastMessage): MediaStatus | null {
    if (m.data?.type !== 'MEDIA_STATUS') return null
    const list = (m.data.status as MediaStatus[] | undefined) ?? []
    const s = list.find(x => this.mediaSessionId === null || x.mediaSessionId === this.mediaSessionId) ?? list[0]
    if (!s) return null
    this.mediaSessionId = s.mediaSessionId
    return s
  }

  private onMessage (m: CastMessage): void {
    const type = m.data?.type
    if (m.namespace === NS.media && type === 'MEDIA_STATUS' && !m.data?.requestId) {
      const s = this.mediaFrom(m)
      if (s) this.emit('media', s)
    } else if (m.namespace === NS.receiver && type === 'RECEIVER_STATUS') {
      const status = m.data!.status as ReceiverStatus
      this.emit('receiver', status)
      // Someone else started another app (or quit ours) on the TV: this cast is over.
      if (this.appSessionId && !(status.applications ?? []).some(a => a.sessionId === this.appSessionId)) {
        this.channel.close(new CastError('replaced', 'The TV switched to something else'))
      }
    } else if (m.namespace === NS.connection && type === 'CLOSE' && m.source === this.transportId) {
      this.channel.close(new CastError('closed', 'The TV closed its player'))
    }
  }
}
