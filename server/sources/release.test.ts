import { describe, expect, it } from 'vitest'
import { parseRelease, parseTorrentioStream } from './release.ts'

describe('parseRelease', () => {
  it('reads a 4K remux with Dolby Vision and lossless audio', () => {
    const r = parseRelease('Interstellar 2014 2160p PROPER IMAX REMUX DV HDR10+ TrueHD 7.1 Atmos-jennaortegaUHD', 'Interstellar.2014.2160p.PROPER.IMAX.REMUX.DV.HDR10+.TrueHD.7.1.Atmos-jennaortegaUHD.mkv')
    expect(r.resolution).toBe('2160p')
    expect(r.source).toBe('REMUX')
    expect(r.hdr).toEqual(expect.arrayContaining(['DV', 'HDR10+']))
    expect(r.audio).toContain('truehd')
    expect(r.container).toBe('mkv')
    expect(r.lowQuality).toBe(false)
  })

  it('reads a typical x264 BluRay rip', () => {
    const r = parseRelease('Interstellar.2014.1080p.Bluray.x264-SURGE')
    expect(r).toMatchObject({ resolution: '1080p', source: 'BluRay', videoCodec: 'h264', tenBit: false, lowQuality: false })
    expect(r.hdr).toEqual([])
  })

  it('reads x265 10bit as hevc 10-bit', () => {
    const r = parseRelease('Interstellar.2014.IMAX.1080p.10bit.BluRay.6CH.x265.HEVC-PSA')
    expect(r.videoCodec).toBe('hevc')
    expect(r.tenBit).toBe(true)
  })

  it('reads AV1 with Opus audio', () => {
    const r = parseRelease('Interstellar 2014 2160p AV1 HDR10 EN/ITA/FR/ES OPUS 5.1-UH [UserHEVC]')
    expect(r.videoCodec).toBe('av1')
    expect(r.audio).toContain('opus')
    expect(r.hdr).toContain('HDR10')
  })

  it('treats DDP5.1 as eac3 and WEB as WEB-DL', () => {
    const r = parseRelease('Breaking.Bad.S01E01.MULTi.1080p.WEB.DDP5.1.x264-TFA.mkv')
    expect(r.audio).toContain('eac3')
    expect(r.source).toBe('WEB-DL')
    expect(r.videoCodec).toBe('h264')
  })

  it('reads codecs written with a space, as some indexers mangle the dot', () => {
    expect(parseRelease('Night of the Living Dead 1968 1080p MAX WEB-DL DDP2 0 H 264-').videoCodec).toBe('h264')
    expect(parseRelease('Show S01E01 1080p WEB H 265').videoCodec).toBe('hevc')
  })

  it('flags cam and telesync releases as low quality', () => {
    expect(parseRelease('Some.Movie.2024.HDCAM.x264').lowQuality).toBe(true)
    expect(parseRelease('Some Movie 2024 1080p HDTS H264').lowQuality).toBe(true)
    expect(parseRelease('Some.Movie.2024.TELESYNC.720p').lowQuality).toBe(true)
    expect(parseRelease('Some.Movie.2024.1080p.WEB-DL.DDP5.1').lowQuality).toBe(false)
  })

  it('does not mistake words that contain "ts" or "cam" for low quality', () => {
    expect(parseRelease('Cameraman.2010.1080p.BluRay.x264').lowQuality).toBe(false)
    expect(parseRelease('The.Tsunami.Effects.2010.1080p.BluRay').lowQuality).toBe(false)
  })

  it('reads 4k spelled out', () => {
    expect(parseRelease('Movie 2019 4K UHD BluRay').resolution).toBe('2160p')
  })

  it('reads the container from the file name in preference to the torrent name', () => {
    expect(parseRelease('Breaking Bad Complete Season 1 2 3 4 5 1080p HEVC', 'Season 1/Breaking Bad - S01E01 - Pilot.m4v').container).toBe('m4v')
  })

  it('returns unknown resolution when none is stated', () => {
    expect(parseRelease('Interstellar (2014) HDRip').resolution).toBe('unknown')
  })
})

describe('parseTorrentioStream', () => {
  it('extracts seeders, size, provider and languages', () => {
    const s = parseTorrentioStream({
      name: 'Torrentio\n4k HDR',
      title: 'Интерстеллар / Interstellar [2014 UHD BDRemux 2160p HDR10]\n👤 196 💾 89.56 GB ⚙️ Rutracker\n🇬🇧 / 🇷🇺',
      infoHash: 'c26f753911e2c24a82049368421423f3ab9d06d8',
      fileIdx: 0,
      behaviorHints: { filename: 'Интерстеллар.2014.UHD.Blu-Ray.Remux.2160p.mkv' },
      sources: ['tracker:udp://tracker.opentrackr.org:1337/announce', 'dht:c26f753911e2c24a82049368421423f3ab9d06d8'],
    })
    expect(s).toMatchObject({
      infoHash: 'c26f753911e2c24a82049368421423f3ab9d06d8',
      fileIdx: 0,
      seeders: 196,
      providers: ['Rutracker'],
      languages: ['en', 'ru'],
      trackers: ['udp://tracker.opentrackr.org:1337/announce'],
      fileName: 'Интерстеллар.2014.UHD.Blu-Ray.Remux.2160p.mkv',
      title: 'Интерстеллар / Interstellar [2014 UHD BDRemux 2160p HDR10]',
    })
    expect(s?.sizeBytes).toBeCloseTo(89.56 * 1024 ** 3, -6)
    expect(s?.release.resolution).toBe('2160p')
  })

  it('keeps the pack name as the title and the inner file as fileName for season packs', () => {
    const s = parseTorrentioStream({
      name: 'Torrentio\n1080p',
      title: 'Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5 1 Silence) [QxR]\nSeason 1/Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).mkv\n👤 545 💾 2.56 GB ⚙️ ThePirateBay',
      infoHash: 'abc',
      fileIdx: 245,
      behaviorHints: { filename: 'Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).mkv' },
    })
    expect(s?.title).toBe('Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5 1 Silence) [QxR]')
    expect(s?.fileIdx).toBe(245)
    expect(s?.seeders).toBe(545)
    expect(s?.languages).toEqual([])
    expect(s?.release.videoCodec).toBe('hevc')
  })

  it('maps "Multi Audio" to the multi language tag', () => {
    const s = parseTorrentioStream({
      name: 'Torrentio\n1080p',
      title: 'Interstellar.2014.MULTi.1080p.BluRay.x264-LOST\n👤 16 💾 13.12 GB ⚙️ Torrent9\nMulti Audio / 🇫🇷',
      infoHash: 'def',
    })
    expect(s?.languages).toEqual(['multi', 'fr'])
  })

  it('handles sizes in MB', () => {
    const s = parseTorrentioStream({ name: 'Torrentio\n720p', title: 'X 720p\n👤 9 💾 481.87 MB ⚙️ ThePirateBay', infoHash: 'a' })
    expect(s?.sizeBytes).toBeCloseTo(481.87 * 1024 ** 2, -3)
  })

  it('rejects streams without an info hash', () => {
    expect(parseTorrentioStream({ name: 'x', title: 'y' })).toBeNull()
  })
})
