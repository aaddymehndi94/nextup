import type { ClientCaps, PlaybackPlan, ProbeResult } from '../../shared/types.ts'

// Pure decision logic: given what the file contains and what the browser can decode,
// do the least work possible. Direct play > remux (copy video) > full transcode.

export type Encoder = 'nvenc' | 'vaapi' | 'qsv' | 'amf' | 'videotoolbox' | 'x264'
export const ENCODERS: Encoder[] = ['nvenc', 'vaapi', 'qsv', 'amf', 'videotoolbox', 'x264']

/** The encoder in use, plus the device for those that need one (a VAAPI render node). */
export interface EncoderChoice {
  encoder: Encoder
  device?: string
}

/** Hardware encoders worth trying on each OS, best first. libx264 always comes last. */
export function encoderCandidates (platform: string, renderNodes: string[]): EncoderChoice[] {
  const hw: EncoderChoice[] = platform === 'darwin' ? [{ encoder: 'videotoolbox' }]
    : platform === 'win32' ? [{ encoder: 'nvenc' }, { encoder: 'qsv' }, { encoder: 'amf' }]
    : platform === 'linux' ? [{ encoder: 'nvenc' }, ...renderNodes.map(device => ({ encoder: 'vaapi' as const, device })), { encoder: 'qsv' }]
    : []
  return [...hw, { encoder: 'x264' }]
}

/**
 * What each encoder needs around the shared filter chain (scale, HDR tone-map), which runs on the CPU:
 * global options before the input, the filters that hand frames to the encoder, and the encoder settings.
 * Decoded frames end up in system memory for every encoder (no -hwaccel_output_format), so the CPU filters
 * always see ordinary frames. The detection test encode uses the same pieces.
 */
export function encoderArgs ({ encoder, device }: EncoderChoice): { global: string[]; filters: string[]; codec: string[] } {
  const rate = ['-b:v', '8M', '-maxrate', '12M', '-bufsize', '24M']
  switch (encoder) {
    case 'nvenc': return {
      global: ['-hwaccel', 'cuda'],
      filters: ['format=yuv420p'],
      codec: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '22', '-b:v', '0', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high', '-forced-idr', '1'],
    }
    case 'vaapi': return {
      // Decode on the same GPU when it can (ffmpeg falls back to software when it can't), upload for encoding.
      global: ['-init_hw_device', `vaapi=va:${device ?? '/dev/dri/renderD128'}`, '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-filter_hw_device', 'va'],
      filters: ['format=nv12', 'hwupload'],
      // Constant QP: the one rate control every VAAPI driver offers (Intel's free iHD driver offers only this).
      codec: ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '22', '-profile:v', 'high'],
    }
    case 'qsv': return {
      // h264_qsv takes system-memory NV12 frames and uploads them itself.
      global: [],
      filters: ['format=nv12'],
      codec: ['-c:v', 'h264_qsv', '-preset', 'veryfast', ...rate, '-profile:v', 'high', '-forced_idr', '1'],
    }
    case 'amf': return {
      global: [],
      filters: ['format=nv12'],
      codec: ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'speed', '-rc', 'vbr_peak', ...rate, '-profile:v', 'high'],
    }
    case 'videotoolbox': return {
      global: [],
      filters: ['format=nv12'],
      codec: ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-profile:v', 'high', '-realtime', '1'],
    }
    case 'x264': return {
      global: [],
      filters: ['format=yuv420p'],
      codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high'],
    }
  }
}

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
  /** Device for encoders that need one (VAAPI render node). */
  hwDevice?: string
}

const KEYFRAME_EVERY_SEC = 2

export function buildFfmpegArgs ({ input, startSec, probe, plan, encoder, hwDevice }: FfmpegArgsInput): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  const enc = encoderArgs({ encoder, device: hwDevice })
  if (!plan.copyVideo) args.push(...enc.global)
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
    filters.push(...enc.filters)
    args.push('-vf', filters.join(','), ...enc.codec)
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
