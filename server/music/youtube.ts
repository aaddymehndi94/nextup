import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { MusicTrack } from '../../shared/music.ts'
import { baseTitle, normName, splitCredit } from './catalog.ts'
import { type AudioSource, type Fetched, run, type SourceStatus } from './source.ts'

// Songs from YouTube, through yt-dlp, on this computer only (docs/adr/0010). The song is found with YouTube
// Music's "Songs" search (official uploads), saved as AAC (.m4a, which every phone and TV plays) into the
// music folder, and played from there. Nothing here runs on another computer or in the cloud.
//
// yt-dlp is found at NEXTTUPP_YTDLP, then data/bin (where "Set up music" puts the official release, checked
// against its published SHA-256), then on PATH. It needs a JavaScript runtime for YouTube; it is given this
// program's own (Node, or the desktop app's Electron running as Node).

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const DAY = 24 * 3600_000
/** H.264 + AAC in MP4, at most 720p: plays in every browser, phone and TV. */
const VIDEO_FORMAT = 'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[ext=mp4]'

/** The release file for this computer. */
function asset (): string | null {
  const { platform, arch } = process
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : arch === 'x64' ? 'yt-dlp.exe' : 'yt-dlp_x86.exe'
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : arch === 'x64' ? 'yt-dlp_linux' : null
  return null
}

const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'

function onPath (name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    try { if (statSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}

export interface Candidate { id: string; title: string; duration?: number; channel?: string }

const VERSIONS = /\b(live|cover|karaoke|instrumental|remix|slowed|reverb|sped ?up|8d|lo-?fi|nightcore|reprise|acoustic|unplugged|mashup|lyrics?|lyrical|teaser|reaction)\b/i

/**
 * The upload that is this song: same title, closest length, and not a version the song itself isn't
 * (a live take, a cover, slowed + reverb…). YouTube Music's Songs search puts the official audio first, so
 * order breaks ties.
 */
export function pickUpload (track: MusicTrack, list: Candidate[], opts: { video?: boolean } = {}): Candidate | null {
  const want = normName(baseTitle(track.title))
  const wantWords = want.split(' ').filter(w => w.length > 1)
  const own = new Set((track.title.match(VERSIONS) ?? []).map(s => s.toLowerCase()))
  const names = splitCredit(track.credit ?? track.artist.name).map(normName)
  let best: { c: Candidate; score: number } | null = null
  list.forEach((c, i) => {
    const title = normName(c.title)
    const versions = (c.title.match(new RegExp(VERSIONS.source, 'gi')) ?? []).map(s => s.toLowerCase())
    if (versions.some(v => !own.has(v) && !(opts.video && /^lyric/.test(v)))) return
    const hits = wantWords.filter(w => title.includes(w)).length
    if (wantWords.length && hits / wantWords.length < 0.6) return
    let score = 10 - i * 1.5 + (hits / Math.max(1, wantWords.length)) * 4
    if (names.some(n => n && (title.includes(n) || normName(c.channel ?? '').includes(n)))) score += 3
    if (/ - topic$/i.test(c.channel ?? '')) score += opts.video ? -4 : 3
    if (opts.video && /official (music )?video|\bofficial\b/i.test(c.title)) score += 4
    if (track.duration && c.duration) {
      const off = c.duration - track.duration
      if (!opts.video && Math.abs(off) > 15) return
      if (opts.video && (off < -10 || off > 240)) return
      score -= Math.abs(off) / (opts.video ? 30 : 4)
    }
    if (!best || score > best.score) best = { c, score }
  })
  return (best as { c: Candidate } | null)?.c ?? null
}

export class YoutubeSource implements AudioSource {
  readonly kind = 'youtube' as const
  private readonly dataDir: string
  private readonly ffmpeg: string
  private readonly log: (msg: string) => void
  private readonly fetch: typeof fetch
  private readonly stallMs: number
  private installing: Promise<void> | null = null
  private progress: { got: number; total: number } | null = null
  private problem: string | undefined
  private lastUpdate = 0

  constructor (opts: { dataDir: string; ffmpeg: string; log?: (msg: string) => void; fetch?: typeof fetch; stallMs?: number }) {
    this.fetch = opts.fetch ?? fetch
    this.stallMs = opts.stallMs ?? 45_000
    this.dataDir = opts.dataDir
    this.ffmpeg = opts.ffmpeg
    this.log = opts.log ?? (() => {})
  }

  private get ownBinary (): string { return join(this.dataDir, 'bin', exe) }

  binary (): string | null {
    const env = process.env.NEXTTUPP_YTDLP
    if (env && existsSync(env)) return env
    if (existsSync(this.ownBinary)) return this.ownBinary
    return onPath(exe)
  }

  status (): SourceStatus {
    if (this.installing) {
      const p = this.progress
      if (!p?.total) return { helper: 'installing', message: 'Starting the download.' }
      const mb = (n: number) => Math.round(n / 1e6)
      return { helper: 'installing', message: `Downloading ${mb(p.got)} of ${mb(p.total)} MB.`, progress: Math.min(1, p.got / p.total) }
    }
    if (!this.binary()) {
      return this.problem
        ? { helper: 'error', message: this.problem }
        : { helper: 'missing', message: asset() ? 'Music needs a small free helper (yt-dlp, about 40 MB) on this computer.' : 'Music isn’t available on this kind of computer yet.' }
    }
    return { helper: 'ok' }
  }

  install (): Promise<void> {
    this.installing ??= this.download().then(
      () => { this.problem = undefined },
      err => { this.problem = `Couldn’t set up music: ${(err as Error).message}`; throw err },
    ).finally(() => { this.installing = null })
    return this.installing
  }

  private async download (): Promise<void> {
    const name = asset()
    if (!name) throw new Error('no helper for this kind of computer')
    const sums = (await this.get(`${RELEASE}/SHA2-256SUMS`)).toString('utf8')
    const expected = sums.split('\n').map(l => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0]
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('the release has no checksum for this computer')
    this.progress = { got: 0, total: 0 }
    try {
      const bin = await this.get(`${RELEASE}/${name}`, (got, total) => { this.progress = { got, total } })
      const got = createHash('sha256').update(bin).digest('hex')
      if (got !== expected) throw new Error('the download didn’t match its checksum')
      mkdirSync(dirname(this.ownBinary), { recursive: true })
      const part = `${this.ownBinary}.part`
      writeFileSync(part, bin, { mode: 0o755 })
      chmodSync(part, 0o755)
      renameSync(part, this.ownBinary)
    } finally {
      this.progress = null
    }
    this.lastUpdate = Date.now()
    this.log(`music: installed yt-dlp (${name})`)
  }

  /**
   * Downloads a file however long it takes on a slow line (40 MB can take minutes), giving up only when
   * nothing arrives for `stallMs`.
   */
  private async get (url: string, onProgress?: (got: number, total: number) => void): Promise<Buffer> {
    const ctl = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error('the download stalled')), this.stallMs) }
    arm()
    try {
      const res = await this.fetch(url, { signal: ctl.signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`)
      const total = Number(res.headers.get('content-length')) || 0
      const chunks: Buffer[] = []
      let got = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        chunks.push(Buffer.from(value))
        got += value.byteLength
        onProgress?.(got, total)
      }
      return Buffer.concat(chunks)
    } catch (err) {
      if (ctl.signal.aborted) throw new Error('the download stalled; check the internet connection and try again')
      throw new Error(`couldn’t download the helper (${(err as Error).message})`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** yt-dlp with the options every call needs. */
  private async ytdlp (args: string[], timeoutMs: number): Promise<string> {
    const bin = this.binary()
    if (!bin) throw new Error('Set up music first.')
    const env: NodeJS.ProcessEnv = { ...process.env }
    // The desktop app's Electron acts as Node for yt-dlp's YouTube player checks.
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const base = ['--no-warnings', '--no-playlist', '--no-progress', '--js-runtimes', `node:${process.execPath}`]
    if (/[\\/]/.test(this.ffmpeg)) base.push('--ffmpeg-location', this.ffmpeg)
    try {
      return await run(bin, [...base, ...args], { timeoutMs, env })
    } catch (err) {
      // YouTube changes often and yt-dlp keeps up; a helper we installed updates itself (at most daily).
      if (bin === this.ownBinary && Date.now() - this.lastUpdate > DAY) {
        this.lastUpdate = Date.now()
        this.log(`music: yt-dlp failed (${(err as Error).message}); updating it`)
        await run(bin, ['-U'], { timeoutMs: 15 * 60_000, env }).catch(e => this.log(`music: update failed: ${(e as Error).message}`))
        return run(bin, [...base, ...args], { timeoutMs, env })
      }
      throw err
    }
  }

  private async search (url: string, limit: number): Promise<Candidate[]> {
    const out = await this.ytdlp(['--flat-playlist', '--playlist-end', String(limit), '-J', url], 45_000)
    const json = JSON.parse(out) as { entries?: Array<Record<string, unknown>> }
    return (json.entries ?? []).map(e => ({
      id: String(e.id ?? ''),
      title: String(e.title ?? ''),
      duration: typeof e.duration === 'number' ? e.duration : undefined,
      channel: typeof e.channel === 'string' ? e.channel : typeof e.uploader === 'string' ? e.uploader : undefined,
    })).filter(c => /^[\w-]{11}$/.test(c.id))
  }

  private query (track: MusicTrack): string {
    return `${splitCredit(track.credit ?? track.artist.name).slice(0, 2).join(' ')} ${baseTitle(track.title)}`
  }

  /** Downloads into a fresh folder next to `dest` and moves the one file it made onto `dest`. */
  private async save (id: string, format: string, dest: string, extra: string[], timeoutMs: number): Promise<number | undefined> {
    const work = `${dest}.dl`
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    try {
      const printed = await this.ytdlp(['-f', format, ...extra, '-o', join(work, 'media.%(ext)s'), '--print', 'after_move:%(duration)s', `https://www.youtube.com/watch?v=${id}`], timeoutMs)
      const file = readdirSync(work).find(f => f.startsWith('media.') && !f.endsWith('.part'))
      if (!file) throw new Error('nothing was saved')
      const path = join(work, file)
      if (dest.endsWith('.m4a') && !file.endsWith('.m4a')) {
        await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', dest], { timeoutMs: 180_000 })
      } else renameSync(path, dest)
      const d = Number.parseFloat(printed.trim().split('\n').pop() ?? '')
      return Number.isFinite(d) && d > 0 ? d : undefined
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  async fetchAudio (track: MusicTrack, dest: string): Promise<Fetched> {
    const q = this.query(track)
    let pick = pickUpload(track, await this.search(`https://music.youtube.com/search?${new URLSearchParams({ q })}#songs`, 6).catch(() => []))
    pick ??= pickUpload(track, await this.search(`ytsearch6:${q} audio`, 6))
    if (!pick) throw new Error('This song isn’t on YouTube Music.')
    const duration = await this.save(pick.id, 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio', dest, [], 240_000)
    return { ref: pick.id, duration }
  }

  async fetchVideo (track: MusicTrack, dest: string): Promise<Fetched | null> {
    const pick = pickUpload(track, await this.search(`ytsearch8:${this.query(track)} official video`, 8), { video: true })
    if (!pick) return null
    const duration = await this.save(pick.id, VIDEO_FORMAT, dest, ['--merge-output-format', 'mp4'], 600_000)
    return { ref: pick.id, duration }
  }

  /** YouTube ids of trailers matching `query` (a title and year): short videos that call themselves trailers first. */
  async findTrailers (query: string): Promise<string[]> {
    const found = (await this.search(`ytsearch8:${query} official trailer`, 8)).filter(c => !c.duration || c.duration <= 300)
    const trailerish = (c: Candidate) => /\b(trailer|teaser)\b/i.test(c.title)
    return [...found.filter(trailerish), ...found.filter(c => !trailerish(c))].map(c => c.id).slice(0, 5)
  }

  /**
   * Saves one YouTube video (a film's trailer, server/trailers.ts) as MP4 at `dest`, like a music video. One
   * longer than `maxSeconds` isn't downloaded, and this fails with "nothing was saved".
   */
  async saveVideo (id: string, dest: string, maxSeconds: number): Promise<number | undefined> {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('not a YouTube video id')
    return this.save(id, VIDEO_FORMAT, dest, ['--merge-output-format', 'mp4', '--match-filters', `duration <= ${maxSeconds} & !is_live`], 30 * 60_000)
  }
}
