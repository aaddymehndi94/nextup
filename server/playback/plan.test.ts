import { describe, expect, it } from 'vitest'
import type { ClientCaps, ProbeResult } from '../../shared/types.ts'
import { buildFfmpegArgs, choosePlan } from './plan.ts'

const chrome: ClientCaps = { h264: true, hevc: false, hevc10: false, av1: true, vp9: true, aac: true, ac3: false, eac3: false, opus: true, mp3: true, flac: true }

const probe = (over: Partial<ProbeResult> & { v?: Partial<NonNullable<ProbeResult['video']>> } = {}): ProbeResult => ({
  durationSec: 7200,
  container: 'mp4',
  video: { index: 0, codec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 800, hdr: false, ...over.v },
  audio: [{ index: 0, codec: 'aac', language: 'eng', channels: 2, default: true }],
  subtitles: [],
  ...over,
} as ProbeResult)

describe('choosePlan', () => {
  it('direct-plays an H.264/AAC mp4', () => {
    expect(choosePlan(probe(), chrome, ['en'])).toMatchObject({ mode: 'direct' })
  })

  it('remuxes an H.264 mkv without touching the video', () => {
    const p = choosePlan(probe({ container: 'mkv' }), chrome, ['en'])
    expect(p).toMatchObject({ mode: 'remux', copyVideo: true, copyAudio: true })
  })

  it('remuxes and converts only the audio when it is AC3', () => {
    const p = choosePlan(probe({ audio: [{ index: 0, codec: 'ac3', channels: 6, default: true }] }), chrome, ['en'])
    expect(p).toMatchObject({ mode: 'remux', copyVideo: true, copyAudio: false })
  })

  it('transcodes HEVC when the browser cannot decode it', () => {
    expect(choosePlan(probe({ container: 'mkv', v: { codec: 'hevc' } }), chrome, ['en'])).toMatchObject({ mode: 'transcode', copyVideo: false })
  })

  it('copies HEVC when the browser can decode it', () => {
    const caps = { ...chrome, hevc: true, hevc10: true }
    expect(choosePlan(probe({ container: 'mkv', v: { codec: 'hevc', pixFmt: 'yuv420p10le' } }), caps, ['en'])).toMatchObject({ mode: 'remux', copyVideo: true })
  })

  it('transcodes 10-bit H.264, which browsers cannot decode', () => {
    expect(choosePlan(probe({ v: { pixFmt: 'yuv420p10le', profile: 'High 10' } }), chrome, ['en'])).toMatchObject({ mode: 'transcode' })
  })

  it('picks the audio track in a preferred language', () => {
    const p = choosePlan(probe({
      container: 'mkv',
      audio: [
        { index: 0, codec: 'ac3', language: 'rus', channels: 6, default: true },
        { index: 1, codec: 'ac3', language: 'eng', channels: 6, default: false },
      ],
    }), chrome, ['en'])
    expect(p.audioTrack).toBe(1)
  })

  it('honours an explicitly requested audio track, leaving direct play if needed', () => {
    const p = choosePlan(probe({ audio: [{ index: 0, codec: 'aac', default: true }, { index: 1, codec: 'aac', language: 'hin', default: false }] }), chrome, ['en'], 1)
    expect(p).toMatchObject({ audioTrack: 1, mode: 'remux' })
  })
})

describe('buildFfmpegArgs', () => {
  const base = { input: 'http://127.0.0.1:1/raw', encoder: 'nvenc' as const }

  it('seeks on the input side and copies video for remux', () => {
    const pr = probe({ container: 'mkv' })
    const args = buildFfmpegArgs({ ...base, startSec: 600, probe: pr, plan: choosePlan(pr, chrome, ['en']) })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args).toContain('copy')
    expect(args.join(' ')).toContain('-map 0:v:0')
    expect(args.join(' ')).toMatch(/frag_keyframe/)
    expect(args.at(-1)).toBe('pipe:1')
  })

  it('omits -ss at the start of the file', () => {
    const pr = probe({ container: 'mkv' })
    expect(buildFfmpegArgs({ ...base, startSec: 0, probe: pr, plan: choosePlan(pr, chrome, ['en']) })).not.toContain('-ss')
  })

  it('downscales 4K and tone-maps HDR when transcoding', () => {
    const pr = probe({ container: 'mkv', v: { codec: 'hevc', width: 3840, height: 2160, pixFmt: 'yuv420p10le', hdr: true } })
    const args = buildFfmpegArgs({ ...base, startSec: 0, probe: pr, plan: choosePlan(pr, chrome, ['en']) }).join(' ')
    expect(args).toContain('h264_nvenc')
    expect(args).toContain('tonemap')
    expect(args).toMatch(/1920/)
  })

  it('falls back to libx264 when no hardware encoder is available', () => {
    const pr = probe({ container: 'mkv', v: { codec: 'hevc' } })
    const args = buildFfmpegArgs({ ...base, encoder: 'x264', startSec: 0, probe: pr, plan: choosePlan(pr, chrome, ['en']) })
    expect(args).toContain('libx264')
  })

  it('tags copied HEVC as hvc1 so browsers accept it in MP4', () => {
    const pr = probe({ container: 'mkv', v: { codec: 'hevc' } })
    const args = buildFfmpegArgs({ ...base, startSec: 0, probe: pr, plan: choosePlan(pr, { ...chrome, hevc: true }, ['en']) })
    expect(args.join(' ')).toContain('-tag:v hvc1')
  })
})
