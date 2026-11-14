import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProbeResult } from '../../shared/types.ts'
import { config } from '../config.ts'
import { frameArgs, grabFrame } from './frame.ts'

const SDR: ProbeResult = { durationSec: 6000, container: 'mkv', video: { index: 0, codec: 'h264', width: 1920, height: 800, hdr: false }, audio: [], subtitles: [] }

describe('a still for the quick look', () => {
  it('reads only the keyframe at or before the moment: no decoding up to it, nothing but that one picture', () => {
    const args = frameArgs({ input: 'http://x/raw', t: 1234.5, probe: SDR })
    const i = args.indexOf('-i')
    expect(args.slice(0, i)).toEqual(expect.arrayContaining(['-skip_frame', 'nokey', '-ss', '1234.50', '-noaccurate_seek']))
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-frames:v', '1']))
    expect(args.at(-1)).toBe('pipe:1')
  })

  it('tone-maps HDR, so the still looks as it will on the screen, not washed out', () => {
    const hdr = { ...SDR, video: { ...SDR.video!, hdr: true, index: 1 } }
    const vf = frameArgs({ input: 'x', t: 1, probe: hdr })
    expect(vf[vf.indexOf('-vf') + 1]).toMatch(/^zscale=t=linear.*tonemap=tonemap=hable.*scale=1280:-2/)
    expect(vf).toContain('0:v:1')
  })
})

const HAVE_FFMPEG = spawnSync(config.ffmpeg, ['-version']).status === 0
describe.skipIf(!HAVE_FFMPEG)('with the real ffmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frame-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('gives a JPEG of the picture at that moment', async () => {
    const file = join(dir, 'clip.mkv')
    const made = spawnSync(config.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=6', '-c:v', 'libx264', '-g', '24', file])
    expect(made.status).toBe(0)
    const jpeg = await grabFrame(frameArgs({ input: file, t: 3, probe: { ...SDR, durationSec: 6, video: { ...SDR.video!, width: 640, height: 360 } } }))
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(jpeg.length).toBeGreaterThan(2000)
  })
})
