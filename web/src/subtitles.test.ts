import { describe, expect, it } from 'vitest'
import type { SubtitleOption } from './api.ts'
import { startingSubtitle } from './subtitles.ts'

// Subtitles are on by default on every screen: the viewer's last language there, else their first language.

const sub = (id: string, lang: string, match: number, preferred: boolean): SubtitleOption =>
  ({ id, lang, label: lang, url: `https://subs5.strem.io/en/download/${id}`, match, preferred })

describe('the subtitle a film starts with', () => {
  // As the server sends them: the viewer's languages first.
  const list = [sub('e1', 'eng', 40, true), sub('e2', 'eng', 100, true), sub('h1', 'hin', 90, true), sub('s1', 'spa', 100, false)]

  it('is on with no choice saved here: the best match in the viewer’s first language', () => {
    expect(startingSubtitle(list, null)?.id).toBe('e2')
  })

  it('follows the language last chosen on this screen', () => {
    expect(startingSubtitle(list, 'hin')?.id).toBe('h1')
    expect(startingSubtitle(list, 'spa')?.id).toBe('s1')
  })

  it('falls back to the viewer’s language when the last one has none for this film', () => {
    expect(startingSubtitle(list, 'fre')?.id).toBe('e2')
  })

  it('stays off when the viewer turned subtitles off here', () => {
    expect(startingSubtitle(list, 'off')).toBeNull()
  })

  it('stays off rather than show a language the viewer doesn’t read', () => {
    expect(startingSubtitle([sub('s1', 'spa', 100, false)], null)).toBeNull()
  })
})
