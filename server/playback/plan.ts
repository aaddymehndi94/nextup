import type { ClientCaps, PlaybackPlan, ProbeResult } from '../../shared/types.ts'

// Pure decision logic: given what the file contains and what the browser can decode,
// do the least work possible. Direct play > remux (copy video) > full transcode.

export type Encoder = 'nvenc' | 'x264'

const ISO2_TO_3: Record<string, string[]> = {
  en: ['eng', 'en'], hi: ['hin', 'hi'], es: ['spa', 'es'], fr: ['fre', 'fra', 'fr'], de: ['ger', 'deu', 'de'],
  it: ['ita', 'it'], ja: ['jpn', 'ja'], ko: ['kor', 'ko'], ru: ['rus', 'ru'], pt: ['por', 'pt'], ta: ['tam', 'ta'],
  te: ['tel', 'te'], zh: ['chi', 'zho', 'zh'],
}

export function languageMatches (trackLang: string | undefined, preferred: string): boolean {
  if (!trackLang) return false
  return (ISO2_TO_3[preferred] ?? [preferred]).includes(trackLang.toLowerCase())
}

function pickAudioTrack (probe: ProbeResult, preferred: string[]): number {
  for (const lang of preferred) {
    const i = probe.audio.findIndex(a => languageMatches(a.language, lang))
    if (i >= 0) return i
  }
  const def = probe.audio.findIndex(a => a.default)
  return def >= 0 ? def : 0
}

function videoSupported (probe: ProbeResult, caps: ClientCaps): boolean {
  const v = probe.video
  if (!v) return true
  const tenBit = /10|12/.test(v.pixFmt ?? '') || /10/.test(v.profile ?? '')
  switch (v.codec) {
    case 'h264': return caps.h264 && !tenBit && !/4:4:4|4:2:2/.test(v.profile ?? '')
    case 'hevc': return caps.hevc && (!tenBit || caps.hevc10)
    case 'av1': return caps.av1
    case 'vp9': return caps.vp9
    default: return false
  }
}

/** Audio the browser decodes natively from the original file (direct play). */
function audioDirect (codec: string, caps: ClientCaps): boolean {
  return ({ aac: caps.aac, mp3: caps.mp3, opus: caps.opus, flac: caps.flac, ac3: caps.ac3, eac3: caps.eac3 } as Record<string, boolean>)[codec] ?? false
}

/** Audio we can copy straight into fragmented MP4 and have every browser play. */
function audioCopyable (codec: string): boolean {
  return codec === 'aac' || codec === 'mp3'
}

export function choosePlan (probe: ProbeResult, caps: ClientCaps, preferredLangs: string[], requestedAudio?: number): PlaybackPlan {
  const audioTrack = requestedAudio !== undefined && probe.audio[requestedAudio] ? requestedAudio : pickAudioTrack(probe, preferredLangs)
  const audio = probe.audio[audioTrack]
  const vOk = videoSupported(probe, caps)
  const containerOk = probe.container === 'mp4' || probe.container === 'webm'
  // Browsers only play the first audio track of a file, so any other track means remuxing.
  const aOk = !audio || (audioDirect(audio.codec, caps) && audioTrack === 0)

  if (containerOk && vOk && aOk) return { mode: 'direct', audioTrack, copyVideo: true, copyAudio: true, reason: 'Browser plays this file as-is' }
  const copyAudio = !audio || audioCopyable(audio.codec)
  if (vOk) {
    return { mode: 'remux', audioTrack, copyVideo: true, copyAudio, reason: copyAudio ? `Repackaging ${probe.container.toUpperCase()} for the browser` : `Converting ${audio!.codec.toUpperCase()} audio` }
  }
  return { mode: 'transcode', audioTrack, copyVideo: false, copyAudio, reason: `Converting ${probe.video?.codec.toUpperCase()} video for this browser` }
}

export interface FfmpegArgsInput {
  input: string
  startSec: number
  probe: ProbeResult
  plan: PlaybackPlan
  encoder: Encoder
}

const KEYFRAME_EVERY_SEC = 2

export function buildFfmpegArgs ({ input, startSec, probe, plan, encoder }: FfmpegArgsInput): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (!plan.copyVideo && encoder === 'nvenc') args.push('-hwaccel', 'cuda')
  // ffmpeg's HTTP client range-seeks into the torrent stream; wait patiently for slow swarms.
  args.push('-rw_timeout', String(180e6), '-fflags', '+genpts')
  // MKV/MP4/WebM carry codec parameters in the header, and ffprobe already told us the streams.
  // Without this ffmpeg reads ~12 MB from the start of the file before it will seek, and on a torrent
  // that means waiting for pieces nobody asked for. Other containers (AVI, TS) need the default probing.
  if (['mkv', 'mp4', 'webm'].includes(probe.container)) args.push('-probesize', '1000000', '-analyzeduration', '0')
  if (startSec > 0) args.push('-ss', startSec.toFixed(3))
  // Keep original timestamps so the player knows exactly where a stream starts. With stream copy the
  // cut lands on the keyframe *before* the requested time, so "requested t" alone would drift.
  args.push('-copyts', '-start_at_zero')
  args.push('-i', input)

  args.push('-map', `0:v:${probe.video?.index ?? 0}`)
  if (probe.audio.length > 0) args.push('-map', `0:a:${plan.audioTrack}`)

  if (plan.copyVideo) {
    args.push('-c:v', 'copy')
    if (probe.video?.codec === 'hevc') args.push('-tag:v', 'hvc1')
  } else {
    const v = probe.video!
    const filters: string[] = []
    if (v.width > 1920 || v.height > 1080) filters.push('scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2')
    if (v.hdr) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv')
    filters.push('format=yuv420p')
    args.push('-vf', filters.join(','))
    if (encoder === 'nvenc') {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '22', '-b:v', '0', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high', '-forced-idr', '1')
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high')
    }
    args.push('-force_key_frames', `expr:gte(t,n_forced*${KEYFRAME_EVERY_SEC})`)
  }

  if (probe.audio.length > 0) {
    if (plan.copyAudio) args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  }

  args.push(
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-max_muxing_queue_size', '4096',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000',
    'pipe:1',
  )
  return args
}
