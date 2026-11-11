import type { MediaType } from '../../shared/types.ts'

// What we ask the model and the shape it must answer in. The model's only job is judgement: which titles
// fit this person or this request, and why. Every title it names is checked against the catalogue
// (resolve.ts) before anyone sees it, so a made-up or misremembered title is dropped, never shown.

/** One title the model suggests. Strict JSON schema: every field required, no extras (both providers accept this). */
export interface Suggestion { title: string; year: number; type: MediaType; imdbId: string; because: string; why: string }

const SUGGESTION = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'year', 'type', 'imdbId', 'because', 'why'],
  properties: {
    title: { type: 'string', description: 'As IMDb lists it' },
    year: { type: 'integer', description: 'Year first released or first aired' },
    type: { type: 'string', enum: ['movie', 'series'] },
    imdbId: { type: 'string', description: 'tt… only if certain, otherwise empty' },
    because: { type: 'string', description: 'The liked title it connects to most, copied exactly from the list, or empty' },
    why: { type: 'string', description: 'At most 12 words' },
  },
} as const

export const SUGGESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titles'],
  properties: { titles: { type: 'array', items: SUGGESTION } },
} as const

const TITLE_RULES = `About each title:
- Only real titles that have been released. Never invent one; leave out anything you are unsure exists.
- title: as IMDb lists it. year: the year it was first released (for a series, the year it first aired). type: "movie" or "series".
- imdbId: its IMDb id (tt followed by digits) only if you are certain of it, otherwise "".
- why: at most 12 words, written to the viewer, on what they will get from it. No spoilers, don't repeat the title.`

export const PICKS_SYSTEM = `You are the recommendation engine of nexttupp, a film and TV app. You get one viewer's ratings and viewing history and choose what they should watch next.

How to choose:
- Work out what they respond to: tone, pacing, themes, craft, creators, countries and languages, era. Not just genres. Their dislikes and the titles they stopped early count as much as their likes.
- Prefer titles that fit several of their likes at once. Mix titles a fan of their favourites probably missed with a few lesser-known ones a keen viewer would know. At most a quarter should be famous crowd-pleasers.
- Cover the different sides of their taste rather than many titles of one kind. At most two titles from the same franchise or creator.
- Include some recent titles (released in the last two years) where they fit.
- If they watch titles from a country or in a language other than English, include some from there.
- Never suggest a title from their lists, and avoid repeating "Suggested before" titles unless one is clearly still among the best fits.
- Respect "Never show" completely. Lean towards "More of".
- because: the title from their likes this connects to most, copied exactly as written in the list, or "" if none does.

${TITLE_RULES}`

export const SEARCH_SYSTEM = `You are the search assistant of nexttupp, a film and TV app. The viewer typed what they feel like watching, in their own words. Suggest titles that answer it.

How to choose:
- Read the request closely: films or series, mood, era, country or language, length, "like X" comparisons, anything to avoid. Every suggestion must fit all of it.
- If the request names one specific title, put that title first, then titles like it.
- Their taste (below) only helps you choose among titles that fit the request. The request comes first.
- Best match first. Up to 20 titles; fewer is fine when few fit well.
- because: a title from their likes, copied exactly as written, only if it is why this fits; otherwise "".

${TITLE_RULES}`

/** One entry of a viewer's history, in the words the Taste page uses ("Liked", "Watched 4 episodes", "Stopped early"). */
export interface HistoryEntry { id?: string; name: string; year?: number; type: MediaType; label: string; weight: number }

export interface TasteText {
  entries: HistoryEntry[]
  /** Feature labels the viewer asked for more of / never to see ("Sci-Fi", "South Korea"). */
  more: string[]
  never: string[]
}

export const titleLine = (e: { name: string; year?: number; type: MediaType }) =>
  `${e.name} (${[e.year, e.type === 'series' ? 'series' : 'film'].filter(Boolean).join(', ')})`

const GROUPS: Array<{ heading: string; match: (label: string) => boolean; max: number }> = [
  { heading: 'Liked', match: l => l === 'Liked', max: 60 },
  { heading: 'Finished', match: l => l === 'Finished', max: 30 },
  { heading: 'Watched several episodes of', match: l => /^Watched \d+ episodes$/.test(l) || l === 'Watching', max: 20 },
  { heading: 'On their list', match: l => l === 'On your list', max: 20 },
  { heading: 'Disliked', match: l => l === 'Disliked', max: 30 },
  { heading: 'Stopped early', match: l => l === 'Stopped early' || l === 'Tried one episode', max: 15 },
  { heading: 'Not interested', match: l => l === 'Not interested', max: 15 },
]

/** The viewer's history as short lists, strongest first. `slim` (search) keeps only likes and dislikes. */
export function tasteText (t: TasteText, opts: { slim?: boolean } = {}): string {
  const parts: string[] = []
  for (const g of GROUPS) {
    if (opts.slim && g.heading !== 'Liked' && g.heading !== 'Disliked') continue
    const max = opts.slim ? Math.min(g.max, 30) : g.max
    const lines = t.entries.filter(e => g.match(e.label)).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, max).map(titleLine)
    if (lines.length) parts.push(`${g.heading}:\n${lines.map(l => `- ${l}`).join('\n')}`)
  }
  if (t.more.length) parts.push(`More of: ${t.more.join(', ')}`)
  if (t.never.length) parts.push(`Never show: ${t.never.join(', ')}`)
  return parts.join('\n\n') || 'No history yet: suggest widely loved titles of different kinds.'
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10)

export function picksPrompt (taste: TasteText, before: string[], now: number, counts = { movie: 20, series: 20 }): string {
  return [
    `Today is ${today(now)}. Suggest ${counts.movie} films and ${counts.series} series for this viewer, best first within each.`,
    tasteText(taste),
    before.length ? `Suggested before:\n${before.map(b => `- ${b}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

export function searchPrompt (query: string, taste: TasteText, now: number): string {
  return [
    `Today is ${today(now)}.`,
    `Request: ${JSON.stringify(query)}`,
    `Their taste (only to choose among titles that fit):\n\n${tasteText(taste, { slim: true })}`,
  ].join('\n\n')
}

/** Reads the model's answer, tolerating a fenced or chatty reply from a provider that ignored the schema. */
export function parseSuggestions (text: string): Suggestion[] {
  let body: unknown
  try { body = JSON.parse(text) } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    if (!m) return []
    try { body = JSON.parse(m[0]) } catch { return [] }
  }
  const titles = (body as { titles?: unknown })?.titles
  if (!Array.isArray(titles)) return []
  const out: Suggestion[] = []
  for (const t of titles) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    if (!title || title.length > 200) continue
    out.push({
      title,
      year: typeof r.year === 'number' && Number.isFinite(r.year) ? Math.round(r.year) : 0,
      type: r.type === 'series' ? 'series' : 'movie',
      imdbId: typeof r.imdbId === 'string' && /^tt\d{5,10}$/.test(r.imdbId.trim()) ? r.imdbId.trim() : '',
      because: typeof r.because === 'string' ? r.because.trim().slice(0, 200) : '',
      why: typeof r.why === 'string' ? r.why.trim().slice(0, 140) : '',
    })
  }
  return out
}
