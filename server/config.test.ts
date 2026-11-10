import { describe, expect, it } from 'vitest'
import { resolveBinary } from './config.ts'

describe('resolveBinary', () => {
  it('uses the configured binary when it exists', () => {
    expect(resolveBinary('/app/ffmpeg/bin/ffmpeg', 'ffmpeg', () => true)).toBe('/app/ffmpeg/bin/ffmpeg')
  })

  it('falls back to the name on PATH when the configured binary is missing', () => {
    expect(resolveBinary('/app/ffmpeg/bin/ffmpeg', 'ffmpeg', () => false)).toBe('ffmpeg')
  })

  it('uses PATH when nothing is configured', () => {
    expect(resolveBinary(undefined, 'ffprobe', () => true)).toBe('ffprobe')
  })
})
