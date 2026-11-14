import { describe, expect, it } from 'vitest'
import type { ClientCaps, ProbeResult } from '../../shared/types.ts'
import { buildFfmpegArgs, choosePlan, encoderCandidates, type Encoder } from './plan.ts'

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

  it('starts converted audio at the copied video’s keyframe, and converts copied audio when the video is converted', () => {
    const mkv = (codec: string, v = 'h264') => probe({ container: 'mkv', v: { codec: v }, audio: [{ index: 0, codec, default: true }] })
    const at = (pr: ReturnType<typeof probe>, t: number) => buildFfmpegArgs({ ...base, startSec: t, probe: pr, plan: choosePlan(pr, chrome, ['en']) })
    // H.264 copied, AC3 converted: both start at the keyframe before 600.
    const remux = at(mkv('ac3'), 600)
    expect(remux.indexOf('-noaccurate_seek')).toBeGreaterThan(-1)
    expect(remux.indexOf('-noaccurate_seek')).toBeLessThan(remux.indexOf('-i'))
    expect(remux.join(' ')).toContain('-c:a aac')
    expect(at(mkv('ac3'), 0)).not.toContain('-noaccurate_seek')
    // HEVC converted (this browser can't), AAC that could be copied: converted too, from 600 exactly.
    const tx = at(mkv('aac', 'hevc'), 600)
    expect(tx).not.toContain('-noaccurate_seek')
    expect(tx.join(' ')).toContain('-c:a aac')
    expect(at(mkv('aac', 'hevc'), 0).join(' ')).toContain('-c:a copy')
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

describe('encoderCandidates', () => {
  const names = (platform: string, nodes: string[] = []) => encoderCandidates(platform, nodes).map(c => c.device ? `${c.encoder}@${c.device}` : c.encoder)

  it('tries the hardware encoders for each OS in order, libx264 last', () => {
    expect(names('darwin')).toEqual(['videotoolbox', 'x264'])
    expect(names('win32')).toEqual(['nvenc', 'qsv', 'amf', 'x264'])
    expect(names('linux', ['/dev/dri/renderD128', '/dev/dri/renderD129'])).toEqual(['nvenc', 'vaapi@/dev/dri/renderD128', 'vaapi@/dev/dri/renderD129', 'qsv', 'x264'])
  })

  it('skips VAAPI on Linux without render nodes', () => {
    expect(names('linux')).toEqual(['nvenc', 'qsv', 'x264'])
  })
})

describe('buildFfmpegArgs per encoder', () => {
  const hdr4k = probe({ container: 'mkv', v: { codec: 'hevc', width: 3840, height: 2160, pixFmt: 'yuv420p10le', hdr: true } })
  const plan = choosePlan(hdr4k, chrome, ['en'])
  const build = (encoder: Encoder, hwDevice?: string) => buildFfmpegArgs({ input: 'http://127.0.0.1:1/raw', startSec: 30, probe: hdr4k, plan, encoder, hwDevice })
  const vf = (args: string[]) => args[args.indexOf('-vf') + 1]

  it('VAAPI opens the render node before the input and uploads NV12 after the tone-map', () => {
    const args = build('vaapi', '/dev/dri/renderD129')
    const i = args.indexOf('-i')
    expect(args.indexOf('-init_hw_device')).toBeLessThan(i)
    expect(args[args.indexOf('-init_hw_device') + 1]).toBe('vaapi=va:/dev/dri/renderD129')
    expect(args.indexOf('-filter_hw_device')).toBeLessThan(i)
    expect(vf(args)).toMatch(/tonemap=.*zscale=t=bt709:m=bt709:r=tv,format=nv12,hwupload$/)
    expect(args).toContain('h264_vaapi')
    expect(args).not.toContain('-hwaccel_output_format')
  })

  it('NVENC decodes with CUDA and encodes yuv420p', () => {
    const args = build('nvenc')
    expect(args.slice(0, args.indexOf('-i'))).toEqual(expect.arrayContaining(['-hwaccel', 'cuda']))
    expect(vf(args)).toMatch(/format=yuv420p$/)
    expect(args).toContain('h264_nvenc')
  })

  it.each([
    ['qsv', 'h264_qsv', 'format=nv12'],
    ['amf', 'h264_amf', 'format=nv12'],
    ['videotoolbox', 'h264_videotoolbox', 'format=nv12'],
    ['x264', 'libx264', 'format=yuv420p'],
  ] as const)('%s takes system-memory frames: no device setup, ends the chain with %s', (encoder, codec, last) => {
    const args = build(encoder)
    expect(args).toContain(codec)
    expect(vf(args).endsWith(last)).toBe(true)
    expect(vf(args)).toContain('tonemap')
    expect(args).not.toContain('-init_hw_device')
    expect(args).not.toContain('-hwaccel')
  })

  it('every encoder keeps a keyframe every 2 s for seekable fragments', () => {
    for (const e of ['nvenc', 'vaapi', 'qsv', 'amf', 'videotoolbox', 'x264'] as const) {
      expect(build(e).join(' ')).toContain('-force_key_frames expr:gte(t,n_forced*2)')
    }
  })

  it('adds no hardware setup when the video is only copied', () => {
    const pr = probe({ container: 'mkv' })
    const args = buildFfmpegArgs({ input: 'x', startSec: 0, probe: pr, plan: choosePlan(pr, chrome, ['en']), encoder: 'vaapi', hwDevice: '/dev/dri/renderD128' })
    expect(args).not.toContain('-init_hw_device')
    expect(args).not.toContain('-hwaccel')
  })
})
