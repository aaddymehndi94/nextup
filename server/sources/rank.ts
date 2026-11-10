import type { Source } from '../../shared/types.ts'

type Candidate = Omit<Source, 'score' | 'notes'>

export interface RankContext {
  /** ISO 639-1 codes, e.g. ['en', 'hi']. */
  preferredLanguages: string[]
  /** Runtime in minutes, used to estimate bitrate from size. */
  runtimeMin?: number
}

/** Collapses duplicates of the same torrent reported by different providers. */
export function mergeSources (list: Candidate[]): Candidate[] {
  const byHash = new Map<string, Candidate>()
  for (const s of list) {
    const key = s.infoHash.toLowerCase()
    const prev = byHash.get(key)
    if (!prev) {
      byHash.set(key, { ...s, infoHash: key, providers: [...s.providers], trackers: [...s.trackers], languages: [...s.languages] })
      continue
    }
    prev.seeders = Math.max(prev.seeders ?? 0, s.seeders ?? 0)
    prev.leechers = prev.leechers ?? s.leechers
    prev.fileIdx = prev.fileIdx ?? s.fileIdx
    prev.fileName = prev.fileName ?? s.fileName
    prev.sizeBytes = prev.sizeBytes ?? s.sizeBytes
    for (const p of s.providers) if (!prev.providers.includes(p)) prev.providers.push(p)
    for (const t of s.trackers) if (!prev.trackers.includes(t)) prev.trackers.push(t)
    for (const l of s.languages) if (!prev.languages.includes(l)) prev.languages.push(l)
  }
  return [...byHash.values()]
}

const RES_SCORE = { '1080p': 30, '2160p': 22, '720p': 18, '480p': 4, unknown: 8 } as const

const LANG_NAMES: Record<string, string> = {
  fr: 'French', es: 'Spanish', it: 'Italian', ru: 'Russian', de: 'German', pt: 'Portuguese', hi: 'Hindi',
  uk: 'Ukrainian', pl: 'Polish', tr: 'Turkish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
}

/** Browser-friendliness of a release, as far as its name tells us. */
export function likelyDirectPlay (s: Candidate): boolean {
  const r = s.release
  const containerOk = r.container === 'mp4' || r.container === 'm4v'
  const audioOk = r.audio.length === 0 || r.audio.every(a => a === 'aac' || a === 'mp3')
  return containerOk && r.videoCodec === 'h264' && !r.tenBit && audioOk
}

export function scoreSource (s: Candidate, ctx: RankContext): { score: number; notes: string[] } {
  const notes: string[] = []
  const r = s.release
  let score = 0

  // Swarm health dominates: a great release nobody seeds is useless for streaming.
  const seeders = s.seeders ?? 0
  if (seeders === 0) { score -= 60; notes.push('No seeders reported') } else {
    score += Math.min(40, Math.log2(seeders + 1) * 6)
    if (seeders < 5) notes.push('Few seeders, may be slow')
    else if (seeders >= 100) notes.push('Very healthy swarm')
  }

  score += RES_SCORE[r.resolution]

  if (r.lowQuality) { score -= 100; notes.push('Camera / telesync recording') }

  const langs = s.languages.filter(l => l !== 'multi' && l !== 'dual')
  const hasMulti = s.languages.includes('multi') || s.languages.includes('dual')
  const wanted = ctx.preferredLanguages
  if (langs.length > 0 && !hasMulti && !langs.some(l => wanted.includes(l))) {
    score -= 45
    notes.push(`Dubbed: ${langs.map(l => LANG_NAMES[l] ?? l).join(', ')}`)
  } else if (langs.some(l => wanted.includes(l) && l !== 'en')) {
    score += 6
  }

  if (likelyDirectPlay(s)) { score += 12; notes.push('Plays without conversion') }
  else if (r.videoCodec === 'xvid') score -= 10
  else if (r.videoCodec === 'h264' && r.tenBit) score -= 8

  if (s.sizeBytes) {
    const runtimeSec = (ctx.runtimeMin ?? 110) * 60
    const mbps = (s.sizeBytes * 8) / runtimeSec / 1e6
    if (mbps > 40) { score -= 30; notes.push(`Very large (~${Math.round(mbps)} Mbps), likely to buffer`) }
    else if (mbps > 20) { score -= 12; notes.push(`Large (~${Math.round(mbps)} Mbps)`) }
    else if (mbps < 1 && r.resolution !== '480p') score -= 6
  }

  return { score: Math.round(score * 10) / 10, notes }
}

export function rankSources (list: Candidate[], ctx: RankContext): Source[] {
  return mergeSources(list)
    .map(s => ({ ...s, ...scoreSource(s, ctx) }))
    .sort((a, b) => b.score - a.score || (b.seeders ?? 0) - (a.seeders ?? 0))
}
