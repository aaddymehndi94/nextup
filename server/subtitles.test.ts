import { describe, expect, it } from 'vitest'
import { isAllowedSubtitleUrl, parseSubtitles, rankSubtitles, releaseMatch } from './subtitles.ts'

describe('parseSubtitles', () => {
  it('parses CRLF SRT with styling tags', () => {
    const cues = parseSubtitles('﻿1\r\n00:00:25,657 --> 00:00:28,203\r\n<i>My dad was a farmer.</i>\r\n\r\n2\r\n01:02:03,000 --> 01:02:04,500\r\nLine one\r\nLine two\r\n')
    expect(cues).toEqual([
      { start: 25.657, end: 28.203, text: 'My dad was a farmer.' },
      { start: 3723, end: 3724.5, text: 'Line one\nLine two' },
    ])
  })

  it('parses WebVTT without hours', () => {
    expect(parseSubtitles('WEBVTT\n\n00:05.000 --> 00:07.250\nHello')).toEqual([{ start: 5, end: 7.25, text: 'Hello' }])
  })
})

describe('isAllowedSubtitleUrl', () => {
  it('allows only the addon subtitle CDN over https', () => {
    expect(isAllowedSubtitleUrl('https://subs5.strem.io/en/download/x')).toBe(true)
    expect(isAllowedSubtitleUrl('http://subs5.strem.io/x')).toBe(false)
    expect(isAllowedSubtitleUrl('https://169.254.169.254/latest')).toBe(false)
    expect(isAllowedSubtitleUrl('https://subs5.strem.io.evil.com/x')).toBe(false)
  })
})

describe('releaseMatch', () => {
  it('ranks the same release group above a different one', () => {
    const file = 'Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv'
    expect(releaseMatch('Interstellar.2014.1080p.BluRay.x264-SPARKS', file)).toBe(100)
    expect(releaseMatch('Interstellar.2014.720p.BluRay.x264-SPARKS', file)).toBeGreaterThan(releaseMatch('Interstellar.2014.720p.HDTS.x264-Pimp4003', file))
  })
})

describe('rankSubtitles', () => {
  const url = (n: number) => `https://subs5.strem.io/en/download/file/${n}`
  it('puts the preferred languages first and marks them, so the player can turn one on by itself', () => {
    const list = rankSubtitles([
      { id: '1', url: url(1), lang: 'spa', movieReleaseName: 'Film.2020.1080p-GRP' },
      { id: '2', url: url(2), lang: 'eng', movieReleaseName: 'Film.2020.720p-OTHER' },
      { id: '3', url: url(3), lang: 'eng', movieReleaseName: 'Film.2020.1080p-GRP' },
      { id: '4', url: 'https://evil.example/x.srt', lang: 'eng' },
    ], 'Film.2020.1080p-GRP.mkv', ['en'])
    expect(list.map(s => [s.id, s.preferred])).toEqual([['3', true], ['2', true], ['1', false]])
  })
})
