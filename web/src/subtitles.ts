import type { SubtitleOption } from './api.ts'

/** What the player saves (per screen, as `subs-lang`) when the viewer turns subtitles off there. */
export const SUBS_OFF = 'off'

/**
 * The subtitle a film starts with. Subtitles are on by default on every screen: the language last chosen on this
 * one, else the viewer's first language (the server lists those first and marks them), the best match to the
 * file within it. Off only when turned off here, or when there's none in a language the viewer reads.
 */
export function startingSubtitle (list: SubtitleOption[], saved: string | null): SubtitleOption | null {
  if (saved === SUBS_OFF) return null
  const lang = (saved && list.some(s => s.lang === saved)) ? saved : list.find(s => s.preferred)?.lang
  if (!lang) return null
  return list.filter(s => s.lang === lang).reduce<SubtitleOption | null>((best, s) => (best && best.match >= s.match ? best : s), null)
}
