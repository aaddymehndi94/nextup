import { config } from './config.ts'
import { fetchJson } from './http.ts'

export interface Cue { start: number; end: number; text: string }

export interface SubtitleOption {
  id: string
  lang: string
  label: string
  /** Subtitle file's original release name, used to match the playing release. */
  release?: string
  url: string
  /** Higher is a better match for the release being played. */
  match: number
}

const LANG_LABEL: Record<string, string> = {
  eng: 'English', hin: 'Hindi', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian', por: 'Portuguese',
  pob: 'Portuguese (BR)', rus: 'Russian', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', ara: 'Arabic', tur: 'Turkish',
  dut: 'Dutch', pol: 'Polish', swe: 'Swedish', tam: 'Tamil', tel: 'Telugu', ben: 'Bengali', ind: 'Indonesian',
}
const ISO2_TO_639_2: Record<string, string> = { en: 'eng', hi: 'hin', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', ta: 'tam', te: 'tel' }

/** Only fetch subtitle files from the addon's own CDN; never act as an open proxy. */
export function isAllowedSubtitleUrl (url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /^subs\d*\.strem\.io$/.test(u.hostname)
  } catch { return false }
}

const norm = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** How well a subtitle's release name matches the file being played (0 = unknown). */
export function releaseMatch (subRelease: string | undefined, fileName: string | undefined): number {
  if (!subRelease || !fileName) return 0
  const a = norm(subRelease)
  const b = norm(fileName)
  if (a === b) return 100
  const group = (s: string) => s.split(' ').at(-1)
  let score = 0
  if (group(a) && group(a) === group(b)) score += 40
  const ta = new Set(a.split(' '))
  const tb = b.split(' ')
  score += Math.round(30 * tb.filter(t => ta.has(t)).length / Math.max(tb.length, 1))
  return score
}

interface AddonSub { id: string; url: string; lang: string; movieReleaseName?: string; subtitleFileName?: string }

export async function listSubtitles (type: 'movie' | 'series', streamId: string, fileName?: string): Promise<SubtitleOption[]> {
  const extra = fileName ? `/filename=${encodeURIComponent(fileName)}` : ''
  const data = await fetchJson<{ subtitles?: AddonSub[] }>(`${config.openSubtitlesUrl}/subtitles/${type}/${streamId}${extra}.json`, { timeoutMs: 15_000, cacheMs: 3600_000 })
  const wanted = config.preferredLanguages.map(l => ISO2_TO_639_2[l] ?? l)
  return (data.subtitles ?? [])
    .filter(s => isAllowedSubtitleUrl(s.url))
    .map(s => ({
      id: s.id,
      lang: s.lang,
      label: LANG_LABEL[s.lang] ?? s.lang,
      release: s.movieReleaseName ?? s.subtitleFileName,
      url: s.url,
      match: releaseMatch(s.movieReleaseName ?? s.subtitleFileName, fileName),
    }))
    .sort((a, b) => {
      const la = wanted.indexOf(a.lang); const lb = wanted.indexOf(b.lang)
      const pa = la < 0 ? 99 : la; const pb = lb < 0 ? 99 : lb
      return pa - pb || a.label.localeCompare(b.label) || b.match - a.match
    })
}

function toSeconds (t: string): number {
  const m = t.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/)
  if (!m) return NaN
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

/** Parses SRT or WebVTT into cues. Tolerant of CRLF, BOMs, missing indices and styling tags. */
export function parseSubtitles (text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const ti = lines.findIndex(l => l.includes('-->'))
    if (ti < 0) continue
    const [a, b] = lines[ti].split('-->')
    const start = toSeconds(a)
    const end = toSeconds(b)
    if (Number.isNaN(start) || Number.isNaN(end)) continue
    const body = lines.slice(ti + 1).join('\n')
      .replace(/<\/?(?:i|b|u|font)[^>]*>/gi, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues.sort((x, y) => x.start - y.start)
}

/**
 * Downloaded subtitles by URL. The player, the TV (which may fetch a track again after every seek) and a
 * reload all ask for the same file, and the subtitle service answers bursts with HTTP 429. A failure is kept
 * for a minute, so a refused file isn't asked for again at once.
 */
const cueCache = new Map<string, { at: number; failed: boolean; job: Promise<Cue[]> }>()
const CUES_KEPT_MS = 6 * 3600_000
/** A failed download is answered from memory this long (the TV fetches its few tracks at once), then tried again. */
const FAILURE_KEPT_MS = 15_000

export function fetchCues (url: string): Promise<Cue[]> {
  if (!isAllowedSubtitleUrl(url)) return Promise.reject(new Error('Subtitle URL not allowed'))
  const now = Date.now()
  const hit = cueCache.get(url)
  if (hit && now - hit.at < (hit.failed ? FAILURE_KEPT_MS : CUES_KEPT_MS)) return hit.job
  const job = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`Subtitle download failed: HTTP ${res.status}`)
    return parseSubtitles(await res.text())
  })()
  const entry = { at: now, failed: false, job }
  job.catch(() => { entry.failed = true; entry.at = Date.now() })
  cueCache.delete(url)
  cueCache.set(url, entry)
  if (cueCache.size > 80) cueCache.delete(cueCache.keys().next().value!)
  return job
}

const vttTime = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor(ms / 60_000) % 60
  const sec = Math.floor(ms / 1000) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

/** Cues as WebVTT, moved by `shift` seconds (for a stream whose clock starts later in the film). */
export function toWebVtt (cues: Cue[], shift = 0): string {
  const out = ['WEBVTT', '']
  for (const c of cues) {
    const start = c.start + shift
    const end = c.end + shift
    if (end <= 0) continue
    // A blank line would end the cue early, and "-->" would start a new one.
    const text = c.text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').replace(/-->/g, '→').trim()
    if (!text) continue
    out.push(`${vttTime(start)} --> ${vttTime(end)}`, text, '')
  }
  return out.join('\n')
}
