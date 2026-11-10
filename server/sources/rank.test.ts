import { describe, expect, it } from 'vitest'
import { mergeSources, rankSources } from './rank.ts'
import { parseRelease } from './release.ts'

const src = (title: string, extra: Record<string, unknown> = {}) => ({
  infoHash: title.replace(/\W/g, '').toLowerCase().slice(0, 40),
  title,
  providers: ['1337x'],
  languages: [] as string[],
  trackers: [] as string[],
  release: parseRelease(title, extra.fileName as string | undefined),
  seeders: 50,
  sizeBytes: 4 * 1024 ** 3,
  ...extra,
})

const ctx = { preferredLanguages: ['en'], runtimeMin: 120 }

describe('rankSources', () => {
  it('puts a healthy 1080p release above a camera recording with more seeders', () => {
    const [first] = rankSources([
      src('Movie.2024.HDCAM.x264', { seeders: 900 }),
      src('Movie.2024.1080p.WEB-DL.x264', { seeders: 40 }),
    ], ctx)
    expect(first.title).toBe('Movie.2024.1080p.WEB-DL.x264')
  })

  it('prefers a release in a preferred language over a foreign dub', () => {
    const [first] = rankSources([
      src('Movie.2024.FRENCH.1080p.BluRay.x264', { seeders: 200, languages: ['fr'] }),
      src('Movie.2024.1080p.BluRay.x264', { seeders: 60 }),
    ], ctx)
    expect(first.title).toBe('Movie.2024.1080p.BluRay.x264')
  })

  it('accepts multi-audio releases as containing the preferred language', () => {
    const ranked = rankSources([src('Movie.2024.MULTi.1080p.BluRay.x264', { languages: ['multi', 'fr'] })], ctx)
    expect(ranked[0].notes.join(' ')).not.toMatch(/dub/i)
  })

  it('penalises a dead torrent', () => {
    const [first] = rankSources([
      src('Movie.2024.1080p.BluRay.x264-DEAD', { seeders: 0 }),
      src('Movie.2024.720p.BluRay.x264', { seeders: 30 }),
    ], ctx)
    expect(first.title).toBe('Movie.2024.720p.BluRay.x264')
  })

  it('demotes a 90 GB remux below a sensible 1080p encode for streaming', () => {
    const [first] = rankSources([
      src('Movie 2024 2160p REMUX DV TrueHD', { seeders: 300, sizeBytes: 90 * 1024 ** 3 }),
      src('Movie.2024.1080p.BluRay.x264', { seeders: 80, sizeBytes: 8 * 1024 ** 3 }),
    ], ctx)
    expect(first.title).toBe('Movie.2024.1080p.BluRay.x264')
  })

  it('notes when a release can play without conversion', () => {
    const [r] = rankSources([src('Movie.2024.1080p.WEB.x264.AAC', { fileName: 'Movie.2024.1080p.WEB.x264.AAC.mp4' })], ctx)
    expect(r.notes).toContain('Plays without conversion')
  })
})

describe('mergeSources', () => {
  it('merges the same torrent from two providers, keeping the best data from each', () => {
    const a = { ...src('Movie.2024.1080p.BluRay.x264', { seeders: 40, fileIdx: 2, providers: ['1337x'] }), infoHash: 'aaa' }
    const b = { ...src('Movie.2024.1080p.BluRay.x264', { seeders: 55, leechers: 12, providers: ['ThePirateBay'], trackers: ['udp://x'] }), infoHash: 'AAA' }
    const merged = mergeSources([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ infoHash: 'aaa', seeders: 55, leechers: 12, fileIdx: 2, providers: ['1337x', 'ThePirateBay'], trackers: ['udp://x'] })
  })
})
