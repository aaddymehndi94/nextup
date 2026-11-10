import type { MediaType } from '../../shared/types.ts'
import type { ProgressRow, TasteSnapshot } from './types.ts'

// Turns a profile's raw state (ratings, list, progress, dismissals) into one weighted taste signal per
// title. Pure. Weights and decay are the knobs; docs/adr/0003 explains the choices.

export const DAY = 86_400_000

/**
 * Signal weights, strongest first: an explicit like/dislike, then finishing, then stopping early
 * (a mild negative), then a My List add. A single short play is nearly nothing, so one accidental or
 * borrowed watch can't take over the feed.
 */
export const WEIGHTS = {
  like: 1.0,
  dislike: -1.0,
  /** Ratings tapped on the onboarding screen: quick calls on famous titles, slightly less telling. */
  onboardingScale: 0.8,
  complete: 0.6,
  /** Series: first finished episode, plus this per further episode, up to seriesMax. */
  seriesFirst: 0.35,
  seriesPerEpisode: 0.08,
  seriesMax: 0.85,
  /** Stopped in the first quarter after giving it a real try, and not come back for a week. */
  abandon: -0.3,
  list: 0.25,
  /** Watching right now: base + perFraction × how far in. */
  watchingBase: 0.08,
  watchingPerFraction: 0.25,
  /** Under two minutes, or skipped straight to the end. */
  play: 0.03,
  notInterested: -0.5,
  /** When a title is liked, implicit positives can add at most this on top. */
  likeBonusCap: 0.25,
}

/** Exponential decay towards a floor: old explicit ratings still count, old implicit behaviour mostly doesn't. */
export const DECAY = {
  explicit: { halfLifeDays: 365, floor: 0.35 },
  implicit: { halfLifeDays: 90, floor: 0.1 },
}

/** Below this much real playback a play is treated as accidental. */
export const ACCIDENTAL_SEC = 120
/** No progress for this long and an unfinished title counts as stopped. */
export const STALE_DAYS = 7

export function decay (ageMs: number, kind: 'explicit' | 'implicit'): number {
  const { halfLifeDays, floor } = DECAY[kind]
  return floor + (1 - floor) * 0.5 ** (Math.max(0, ageMs) / (halfLifeDays * DAY))
}

/**
 * A finished title: reached the end (≥90 % or ≤3 min left) after real playback — at least 30 % of it,
 * or 20 minutes for long films (seen partly elsewhere) — not a seek to the credits.
 */
export function isCompleted (position: number, duration: number, watchedSec: number): boolean {
  if (!(duration > 0)) return false
  const nearEnd = position / duration >= 0.9 || duration - position <= 180
  return nearEnd && watchedSec >= Math.min(0.3 * duration, 1200)
}

export type SignalLabel =
  | 'liked' | 'disliked' | 'not_interested' | 'finished' | 'episodes' | 'watching' | 'abandoned' | 'tried' | 'listed' | 'played'

export interface Signal {
  id: string
  type: MediaType
  /** Decayed weight, roughly -1..1.25. */
  weight: number
  /** Rating or "not interested" (the viewer said so) rather than inferred from behaviour. */
  explicit: boolean
  label: SignalLabel
  /** Series: episodes finished. */
  episodes?: number
  at: number
}

interface Part { w: number; label: SignalLabel; at: number; episodes?: number }

/** What watching one title (all its episodes) says about taste. */
export function progressSignal (rows: ProgressRow[], type: MediaType, now: number): Part | null {
  if (!rows.length) return null
  const latest = rows.reduce((a, r) => (r.updatedAt > a.updatedAt ? r : a))
  const stale = now - latest.updatedAt > STALE_DAYS * DAY
  const finished = rows.filter(r => r.completedAt !== undefined)
  if (type === 'series' && finished.length) {
    const n = finished.length
    // One episode and nothing since for three weeks: tried it, didn't continue.
    if (n === 1 && rows.length === 1 && now - latest.updatedAt > 21 * DAY) return { w: 0.1, label: 'tried', at: latest.updatedAt, episodes: 1 }
    return { w: Math.min(WEIGHTS.seriesMax, WEIGHTS.seriesFirst + WEIGHTS.seriesPerEpisode * (n - 1)), label: n > 1 ? 'episodes' : 'finished', at: latest.updatedAt, episodes: n }
  }
  if (type === 'movie' && latest.completedAt !== undefined) {
    // Finished with only part of it played here (seen elsewhere before, or skimmed): a bit less sure.
    const share = latest.duration > 0 ? latest.watchedSec / latest.duration : 0
    return { w: WEIGHTS.complete * (share >= 0.5 ? 1 : 0.75), label: 'finished', at: latest.updatedAt }
  }
  const r = rows.reduce((a, x) => (x.watchedSec > a.watchedSec ? x : a))
  const frac = r.duration > 0 ? r.maxPosition / r.duration : 0
  const scale = type === 'series' ? 0.8 : 1
  if (r.watchedSec < ACCIDENTAL_SEC || frac >= 0.9) return { w: WEIGHTS.play, label: 'played', at: latest.updatedAt }
  if (!stale) return { w: WEIGHTS.watchingBase + WEIGHTS.watchingPerFraction * frac, label: 'watching', at: latest.updatedAt }
  if (frac < 0.25) return { w: WEIGHTS.abandon * scale, label: 'abandoned', at: latest.updatedAt }
  if (frac < 0.5) return { w: WEIGHTS.abandon * 0.4 * scale, label: 'abandoned', at: latest.updatedAt }
  return { w: 0.12, label: 'watching', at: latest.updatedAt }
}

/** One signal per title the profile has touched, strongest |weight| first. */
export function computeSignals (snap: TasteSnapshot, now: number): Signal[] {
  const byId = new Map<string, { type: MediaType; rating?: TasteSnapshot['ratings'][number]; list?: TasteSnapshot['list'][number]; progress: ProgressRow[]; notInterested?: number }>()
  const entry = (id: string, type: MediaType) => {
    let e = byId.get(id)
    if (!e) { e = { type, progress: [] }; byId.set(id, e) }
    return e
  }
  for (const r of snap.ratings) entry(r.id, r.type).rating = r
  for (const l of snap.list) entry(l.id, l.type).list = l
  for (const p of snap.progress) entry(p.id, p.type).progress.push(p)
  for (const d of snap.dismissals) if (d.reason === 'not_interested') entry(d.id, d.type).notInterested = d.at

  const out: Signal[] = []
  for (const [id, e] of byId) {
    const parts: Part[] = []
    if (e.list) parts.push({ w: WEIGHTS.list * decay(now - e.list.addedAt, 'implicit'), label: 'listed', at: e.list.addedAt })
    const p = progressSignal(e.progress, e.type, now)
    if (p) parts.push({ ...p, w: p.w * decay(now - p.at, 'implicit') })
    const implicit = Math.max(-0.5, Math.min(0.9, parts.reduce((s, x) => s + x.w, 0)))
    const strongest = parts.reduce<Part | null>((a, x) => (!a || Math.abs(x.w) > Math.abs(a.w) ? x : a), null)
    const at = Math.max(e.rating?.at ?? 0, e.notInterested ?? 0, ...parts.map(x => x.at))

    let signal: Signal | null = null
    if (e.rating) {
      const base = (e.rating.value === 1 ? WEIGHTS.like : WEIGHTS.dislike) * (e.rating.source === 'onboarding' ? WEIGHTS.onboardingScale : 1)
      const explicit = base * decay(now - e.rating.at, 'explicit')
      // A dislike trumps having watched it; a like gains a little from having finished it too.
      const weight = e.rating.value === 1 ? explicit + Math.min(WEIGHTS.likeBonusCap, Math.max(0, implicit)) : explicit
      signal = { id, type: e.type, weight, explicit: true, label: e.rating.value === 1 ? 'liked' : 'disliked', at }
    } else if (e.notInterested !== undefined) {
      signal = { id, type: e.type, weight: WEIGHTS.notInterested * decay(now - e.notInterested, 'explicit') + Math.min(0, implicit), explicit: true, label: 'not_interested', at }
    } else if (strongest) {
      signal = { id, type: e.type, weight: implicit, explicit: false, label: strongest.label, at }
    }
    if (signal) {
      if (p?.episodes) signal.episodes = p.episodes
      out.push(signal)
    }
  }
  return out.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
}

/** Titles never to recommend: rated (liked ones have been seen), dismissed for any reason, finished, or being watched. */
export function exclusions (snap: TasteSnapshot): Set<string> {
  const out = new Set<string>()
  for (const r of snap.ratings) out.add(r.id)
  for (const d of snap.dismissals) out.add(d.id)
  for (const p of snap.progress) {
    // Past an accidental play it belongs in Continue watching (or was finished/abandoned), not in picks.
    if (p.completedAt !== undefined || p.watchedSec >= ACCIDENTAL_SEC) out.add(p.id)
  }
  return out
}

export interface Strength {
  /** Signals at or above a completion's weight (likes, finishes). */
  positives: number
  negatives: number
  /** 0..1: how much ranking leans on the profile versus general quality. */
  confidence: number
  coldStart: boolean
}

/** Personalised rows need about three clear positives; below that the home screen is popular + onboarding. */
export const COLD_START_POSITIVES = 3

export function strength (signals: Signal[]): Strength {
  const positives = signals.filter(s => s.weight >= 0.4).length
  const negatives = signals.filter(s => s.weight <= -0.25).length
  const mass = signals.reduce((m, s) => m + Math.max(0, s.weight), 0)
  return { positives, negatives, confidence: Math.sqrt(Math.min(1, mass / 3)), coldStart: positives < COLD_START_POSITIVES }
}

const LABEL_TEXT: Record<SignalLabel, string> = {
  liked: 'Liked',
  disliked: 'Disliked',
  not_interested: 'Not interested',
  finished: 'Finished',
  episodes: 'Watched episodes',
  watching: 'Watching',
  abandoned: 'Stopped early',
  tried: 'Tried one episode',
  listed: 'On your list',
  played: 'Played briefly',
}

export function signalLabel (s: Signal): string {
  if (s.label === 'episodes' && s.episodes) return `Watched ${s.episodes} episodes`
  return LABEL_TEXT[s.label]
}
