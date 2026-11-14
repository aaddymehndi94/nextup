import type { ProbeResult, Resolution } from '../../shared/types.ts'
import { languageName, RES_LABEL } from './format.ts'

// What a source's file really is, from its header: the facts at the top of the quick look (SourcePeek), where a
// listing's claims ("1080p") meet the picture itself.

export interface QuickLook {
  /** "1920×800 · HEVC · HDR" */
  picture: string
  /** File size over running time: the best single sign of picture quality. "8.9 Mbps" */
  bitrate: string | null
  /** "English 5.1", "Hindi stereo" */
  audio: string[]
  subtitles: string[]
  warnings: string[]
}

/** Film times for `n` stills, from 10% to 80% of the way through: past the opening, before the credits. */
export function stillTimes (durationSec: number, n: number): number[] {
  if (!(durationSec > 0) || n < 1) return []
  return Array.from({ length: n }, (_, i) => Math.round(durationSec * (0.1 + (n === 1 ? 0 : i * 0.7 / (n - 1)))))
}

const CODEC: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2' }
// Newer codecs get about this much more picture from each bit.
const EFFICIENCY: Record<string, number> = { hevc: 1.6, av1: 1.8, vp9: 1.5 }
/** Below this many Mbps per megapixel (H.264-equivalent), a film looks soft or blocky in motion. */
const LOW_MBPS_PER_MP = 1.2

/** The class a picture really is. By width first: a widescreen film is letterboxed, so its height is less. */
function actualResolution (w: number, h: number): Resolution {
  if (w >= 3200 || h >= 1800) return '2160p'
  if (w >= 1800 || h >= 1000) return '1080p'
  if (w >= 1200 || h >= 700) return '720p'
  return '480p'
}

const channels = (n?: number) => n === 1 ? 'mono' : n === 2 ? 'stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? `${n} channels` : ''
const known = (code?: string): code is string => Boolean(code && code !== 'und')
const UNMARKED = 'language not marked'
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** "English 5.1"; without a language tag (common in small encodes), "5.1, language not marked". */
function soundtrack (language?: string, n?: number): string {
  if (known(language)) return [languageName(language), channels(n)].filter(Boolean).join(' ')
  return capital(channels(n) ? `${channels(n)}, ${UNMARKED}` : UNMARKED)
}

export function quickLook (probe: ProbeResult, listed: Resolution, fileSize: number): QuickLook {
  const v = probe.video
  const warnings: string[] = []
  let picture = 'No picture'
  let bitrate: string | null = null
  if (v) {
    picture = [`${v.width}×${v.height}`, CODEC[v.codec] ?? v.codec.toUpperCase(), v.hdr ? 'HDR' : ''].filter(Boolean).join(' · ')
    if (listed !== 'unknown' && actualResolution(v.width, v.height) !== listed) {
      warnings.push(`Listed as ${RES_LABEL[listed]}, but the picture is ${v.width}×${v.height}`)
    }
    if (fileSize > 0 && probe.durationSec > 0) {
      const mbps = fileSize * 8 / probe.durationSec / 1e6
      bitrate = `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`
      const perMp = mbps * (EFFICIENCY[v.codec] ?? 1) / (v.width * v.height / 1e6)
      if (perMp < LOW_MBPS_PER_MP) warnings.push('Low bitrate for its size: it may look soft or blocky')
    }
  }
  return {
    picture,
    bitrate,
    audio: probe.audio.map(a => soundtrack(a.language, a.channels)),
    subtitles: [...new Set(probe.subtitles.map(s => (known(s.language) ? languageName(s.language) : capital(UNMARKED))))],
    warnings,
  }
}
