import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync } from 'node:fs'
import type { ProbeResult, StreamInfo } from '../../shared/types.ts'
import { config } from '../config.ts'
import { ENCODERS, encoderArgs, encoderCandidates, type Encoder, type EncoderChoice } from './plan.ts'

interface FfprobeStream {
  index: number
  codec_type: string
  codec_name?: string
  profile?: string
  pix_fmt?: string
  width?: number
  height?: number
  channels?: number
  color_transfer?: string
  disposition?: { default?: number; attached_pic?: number }
  tags?: { language?: string; title?: string }
}

export function parseProbe (json: { format?: { duration?: string; format_name?: string }; streams?: FfprobeStream[] }, fileName: string): ProbeResult {
  const streams = json.streams ?? []
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const fmt = json.format?.format_name ?? ''
  // ffprobe reports "matroska,webm" for both; the extension disambiguates.
  const container = fmt.includes('mp4') ? 'mp4' : fmt.includes('matroska') ? (ext === 'webm' ? 'webm' : 'mkv') : (fmt.split(',')[0] || ext)

  const videos = streams.filter(s => s.codec_type === 'video')
  const vIdx = videos.findIndex(s => !s.disposition?.attached_pic)
  const v = vIdx >= 0 ? videos[vIdx] : undefined
  const info = (s: FfprobeStream, i: number): StreamInfo => ({
    index: i,
    codec: s.codec_name ?? 'unknown',
    language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : undefined,
    title: s.tags?.title,
    channels: s.channels,
    default: s.disposition?.default === 1,
  })
  return {
    durationSec: Number(json.format?.duration ?? 0),
    container,
    video: v ? {
      index: vIdx,
      codec: v.codec_name ?? 'unknown',
      profile: v.profile,
      pixFmt: v.pix_fmt,
      width: v.width ?? 0,
      height: v.height ?? 0,
      hdr: v.color_transfer === 'smpte2084' || v.color_transfer === 'arib-std-b67',
    } : undefined,
    audio: streams.filter(s => s.codec_type === 'audio').map(info),
    subtitles: streams.filter(s => s.codec_type === 'subtitle').map(info),
  }
}

/** Runs ffprobe against a URL (our own range-capable torrent stream). */
export function probe (url: string, fileName: string, timeoutMs = 120_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffprobe, ['-v', 'error', '-rw_timeout', String(timeoutMs * 1000), '-print_format', 'json', '-show_format', '-show_streams', '-i', url])
    let out = ''
    let err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Timed out reading the video header from the swarm')) }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err.trim().split('\n').at(-1) ?? code}`))
      try { resolve(parseProbe(JSON.parse(out), fileName)) } catch (e) { reject(e) }
    })
  })
}

/**
 * Film time where a stream-copy that seeks to `t` really begins. Copying can only cut on a keyframe, so
 * ffmpeg starts at the keyframe at or before `t` (often 5–10 s earlier) and the MP4 it writes restarts at
 * zero, so the player can't tell. ffprobe's -read_intervals seeks the same way as ffmpeg's -ss (verified
 * to the millisecond against real output), so its first video packet is that keyframe.
 */
export function findKeyframe (url: string, t: number, container: string, timeoutMs = 60_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const fast = ['mkv', 'mp4', 'webm'].includes(container) ? ['-probesize', '1000000', '-analyzeduration', '0'] : []
    const p = spawn(config.ffprobe, ['-v', 'error', ...fast, '-read_intervals', `${t.toFixed(3)}%+#1`, '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', url])
    let out = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('keyframe lookup timed out')) }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', () => {
      clearTimeout(timer)
      const k = Number.parseFloat(out.split('\n')[0])
      if (Number.isFinite(k)) resolve(k); else reject(new Error('no keyframe found'))
    })
  })
}

/** A one-second test encode through the same arguments real playback uses: an encoder can be listed but unusable. */
export function testEncoder (choice: EncoderChoice, ffmpeg = config.ffmpeg, timeoutMs = 15_000): Promise<boolean> {
  const { global, filters, codec } = encoderArgs(choice)
  const args = ['-hide_banner', '-loglevel', 'error', ...global, '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=1',
    '-vf', filters.join(','), ...codec, '-f', 'null', '-']
  return new Promise(resolve => {
    const p = spawn(ffmpeg, args, { stdio: 'ignore' })
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.on('error', () => { clearTimeout(timer); resolve(false) })
    p.on('close', code => { clearTimeout(timer); resolve(code === 0) })
  })
}

const renderNodes = (): string[] => {
  try { return readdirSync('/dev/dri').filter(f => /^renderD\d+$/.test(f)).sort().map(f => `/dev/dri/${f}`) } catch { return [] }
}

/**
 * Picks the video encoder once at startup: the first hardware encoder for this OS that passes a test encode
 * (macOS VideoToolbox; Windows NVENC, QSV, AMF; Linux NVENC, VAAPI on each render node, QSV), else libx264.
 * `forced` (NEXTTUPP_ENCODER) restricts the search to one encoder and uses it even if its test fails.
 */
export async function detectEncoder ({ forced, vaapiDevice, platform = process.platform, log = () => {} }: {
  forced?: string
  vaapiDevice?: string
  platform?: string
  log?: (msg: string) => void
} = {}): Promise<EncoderChoice> {
  const nodes = vaapiDevice ? [vaapiDevice] : renderNodes()
  let candidates = encoderCandidates(platform, nodes)
  if (forced) {
    if (!ENCODERS.includes(forced as Encoder)) log(`Unknown encoder "${forced}", ignoring. Known: ${ENCODERS.join(', ')}`)
    else {
      const own = candidates.filter(c => c.encoder === forced)
      candidates = own.length ? own : [{ encoder: forced as Encoder, device: forced === 'vaapi' ? nodes[0] : undefined }]
    }
  }
  for (const c of candidates) {
    if (c.encoder === 'x264' && !forced) return c
    if (await testEncoder(c)) return c
    log(`Encoder ${c.encoder}${c.device ? ` (${c.device})` : ''} failed its test encode`)
  }
  if (forced && ENCODERS.includes(forced as Encoder)) {
    log(`Using forced encoder ${forced} anyway`)
    return candidates[0]
  }
  return { encoder: 'x264' }
}

/** Keeps a ceiling on concurrent ffmpeg processes; seeking spawns new ones and old ones must die. */
export class TranscodeRegistry {
  private readonly running = new Map<ChildProcess, string>()
  private readonly max: number
  constructor (max = 3) { this.max = max }

  spawn (sessionId: string, args: string[]): ChildProcess {
    // A new stream for the same session supersedes the old one (the user seeked).
    for (const [proc, sid] of this.running) if (sid === sessionId) proc.kill('SIGKILL')
    while (this.running.size >= this.max) {
      const oldest = this.running.keys().next().value!
      oldest.kill('SIGKILL')
      this.running.delete(oldest)
    }
    const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.running.set(proc, sessionId)
    proc.on('close', () => this.running.delete(proc))
    return proc
  }

  killAll (): void {
    for (const proc of this.running.keys()) proc.kill('SIGKILL')
  }
}
