import { describe, expect, it } from 'vitest'
import type { ProbeResult } from '../../shared/types.ts'
import { quickLook, stillTimes } from './peek.ts'

const GB = 1e9
const film = (video: Partial<NonNullable<ProbeResult['video']>>, audio: ProbeResult['audio'] = []): ProbeResult => ({
  durationSec: 7200, container: 'mkv',
  video: { index: 0, codec: 'h264', width: 1920, height: 800, hdr: false, ...video },
  audio, subtitles: [],
})

describe('the quick look says what the file really is', () => {
  it('takes its stills from across the film, away from the opening and the credits', () => {
    expect(stillTimes(6000, 6)).toEqual([600, 1440, 2280, 3120, 3960, 4800])
    expect(stillTimes(0, 6)).toEqual([])
  })

  it('the picture, its codec, HDR and the real bitrate', () => {
    const q = quickLook(film({ codec: 'hevc', hdr: true }), '1080p', 8 * GB)
    expect(q.picture).toBe('1920×800 · HEVC · HDR')
    expect(q.bitrate).toBe('8.9 Mbps')
    expect(q.warnings).toEqual([])
  })

  it('warns when the picture is smaller than the listing says', () => {
    const q = quickLook(film({ width: 1280, height: 536 }), '1080p', 4 * GB)
    expect(q.warnings).toContain('Listed as 1080p, but the picture is 1280×536')
  })

  it('warns when there is too little data for the size of the picture', () => {
    expect(quickLook(film({}), '1080p', 1.5 * GB).warnings).toContain('Low bitrate for its size: it may look soft or blocky')
    // The same bitrate goes further in HEVC.
    expect(quickLook(film({ codec: 'hevc' }), '1080p', 2.2 * GB).warnings).toEqual([])
  })

  it('names each soundtrack by language and channels', () => {
    const q = quickLook(film({}, [
      { index: 0, codec: 'eac3', language: 'eng', channels: 6, default: true },
      { index: 1, codec: 'aac', language: 'hin', channels: 2, default: false },
      { index: 2, codec: 'aac', channels: 1, default: false },
    ]), '1080p', 4 * GB)
    expect(q.audio).toEqual(['English 5.1', 'Hindi stereo', 'Mono, language not marked'])
  })
})
