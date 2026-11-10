import { spawn, type ChildProcess } from 'node:child_process'
import type { ProbeResult, StreamInfo } from '../../shared/types.ts'
import type { Encoder } from './plan.ts'

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
    const p = spawn('ffprobe', ['-v', 'error', '-rw_timeout', String(timeoutMs * 1000), '-print_format', 'json', '-show_format', '-show_streams', '-i', url])
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

/** Checks once at startup whether NVENC actually works (the encoder can be listed but unusable). */
export function detectEncoder (): Promise<Encoder> {
  return new Promise(resolve => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x144:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'])
    p.on('error', () => resolve('x264'))
    p.on('close', code => resolve(code === 0 ? 'nvenc' : 'x264'))
  })
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
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.running.set(proc, sessionId)
    proc.on('close', () => this.running.delete(proc))
    return proc
  }

  killAll (): void {
    for (const proc of this.running.keys()) proc.kill('SIGKILL')
  }
}
