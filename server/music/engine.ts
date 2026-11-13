import type { MusicTrack } from '../../shared/music.ts'
import { artistIdOf, splitCredit } from './catalog.ts'
import type { ListenRow, Ratings } from './store.ts'

// The music engine without AI (docs/adr/0010). Taste is a score per artist and per song, learned from how
// listens end (heard to the end, skipped in the first 30 s) and from likes, fading with age. Candidates come
// from the similarity graph (artist radios, similar artists, playlists); each is scored by where it came
// from, how much the listener likes its artists, how popular it is and how recently it was heard, then
// arranged so no artist crowds the list.

const DAY = 24 * 3600_000
const HALF_LIFE_DAYS = 60

export interface ArtistTaste { id: string; name: string; score: number; listens: number }

export interface Taste {
  /** Artist id → affinity, roughly −3 (avoid) to +4 (loves). Blocked artists are −∞. */
  artists: Map<string, ArtistTaste>
  /** Song id → what's known about it. */
  songs: Map<string, { liked: boolean; disliked: boolean; completes: number; skips: number; last: number }>
  /** Anything to go on at all. */
  hasSignal: boolean
}

/** Every artist credited on a song, as ids (first credited first). */
export function creditIds (t: { artist: { id: string; name: string }; credit?: string | null }): string[] {
  const names = splitCredit(t.credit ?? t.artist.name)
  const ids = names.map(artistIdOf)
  return ids.includes(t.artist.id) ? [t.artist.id, ...ids.filter(i => i !== t.artist.id)] : [t.artist.id, ...ids]
}

const damp = (x: number) => Math.sign(x) * Math.log1p(Math.abs(x))

export function buildTaste (history: ListenRow[], ratings: Ratings, liked: MusicTrack[], names: (id: string) => string | undefined, now: number): Taste {
  const raw = new Map<string, { score: number; listens: number; name: string }>()
  const bump = (id: string, name: string, by: number, listen = false) => {
    const a = raw.get(id) ?? { score: 0, listens: 0, name }
    a.score += by
    if (listen) a.listens++
    raw.set(id, a)
  }
  const songs: Taste['songs'] = new Map()
  const song = (id: string) => {
    let s = songs.get(id)
    if (!s) { s = { liked: false, disliked: false, completes: 0, skips: 0, last: 0 }; songs.set(id, s) }
    return s
  }

  for (const l of history) {
    const w = 0.5 ** ((now - l.at) / DAY / HALF_LIFE_DAYS)
    const by = l.outcome === 'complete' ? 1 : l.outcome === 'partial' ? 0.3 : -0.8
    const names = splitCredit(l.credit ?? l.artist)
    creditIds({ artist: { id: l.artistId, name: l.artist }, credit: l.credit }).forEach((id, i) => bump(id, i === 0 ? l.artist : names[i] ?? l.artist, by * w * (i === 0 ? 1 : 0.6), i === 0))
    const s = song(l.trackId)
    if (l.outcome === 'complete') s.completes++
    if (l.outcome === 'skip' && now - l.at < 60 * DAY) s.skips++
    s.last = Math.max(s.last, l.at)
  }
  const likedById = new Map(liked.map(t => [t.id, t]))
  for (const [id, r] of ratings.tracks) {
    const s = song(id)
    if (r > 0) s.liked = true
    else s.disliked = true
    const t = likedById.get(id)
    if (t) creditIds(t).forEach((a, i) => bump(a, i === 0 ? t.artist.name : splitCredit(t.credit ?? '')[i] ?? t.artist.name, (r > 0 ? 2.5 : -2) * (i === 0 ? 1 : 0.6)))
  }
  const artists: Taste['artists'] = new Map()
  for (const [id, a] of raw) artists.set(id, { id, name: names(id) ?? a.name, score: damp(a.score), listens: a.listens })
  for (const [id, r] of ratings.artists) {
    const a = artists.get(id) ?? { id, name: names(id) ?? '', score: 0, listens: 0 }
    a.score = r > 0 ? Math.max(a.score, 0) + 3 : Number.NEGATIVE_INFINITY
    artists.set(id, a)
  }
  return { artists, songs, hasSignal: history.length > 0 || ratings.tracks.size > 0 || ratings.artists.size > 0 }
}

/** The artists to build mixes around: liked most, at least a little. */
export function seedArtists (taste: Taste, k: number): ArtistTaste[] {
  return [...taste.artists.values()].filter(a => a.score > 0.4 && a.name).sort((a, b) => b.score - a.score).slice(0, k)
}

/** How much the listener likes the artists on a song (the most-liked one counts, blocked ones block). */
export function artistAffinity (taste: Taste, t: MusicTrack): number {
  let best = 0
  for (const id of creditIds(t)) {
    const a = taste.artists.get(id)
    if (!a) continue
    if (a.score === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY
    best = Math.max(best, a.score)
  }
  return best
}

/** Known to the listener: they've finished a song by an artist on it, or liked one. */
export function isFamiliarArtist (taste: Taste, t: MusicTrack): boolean {
  return creditIds(t).some(id => (taste.artists.get(id)?.listens ?? 0) > 0 || (taste.artists.get(id)?.score ?? 0) >= 2.5)
}

export interface Candidate {
  track: MusicTrack
  /** How well it fits what was asked (its place in a radio or playlist), 0–1. */
  fit: number
  why: string
}

export interface ScoreOptions {
  now: number
  /** How much taste counts against fit: high for "your mix", low for a radio someone started. */
  tasteWeight: number
  /** Favour songs they already know (1), or new ones (−1), or neither (0). */
  familiarity?: number
  /** A day number or similar: changes the small shuffle so mixes differ day to day. */
  seed?: number
  /** Ids to leave out (already queued). */
  exclude?: Set<string>
  /** Keep recently heard songs (On repeat). */
  allowRecent?: boolean
}

/** A small deterministic shuffle per song and seed, in [−0.5, 0.5). */
function jitter (id: string, seed: number): number {
  let h = seed | 0
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761)
  return ((h >>> 0) % 1000) / 1000 - 0.5
}

export function score (taste: Taste, c: Candidate, o: ScoreOptions): number {
  const t = c.track
  if (o.exclude?.has(t.id)) return Number.NEGATIVE_INFINITY
  const s = taste.songs.get(t.id)
  if (s?.disliked || (s?.skips ?? 0) >= 2) return Number.NEGATIVE_INFINITY
  const aff = artistAffinity(taste, t)
  if (aff === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY
  let v = c.fit * 2 + aff * o.tasteWeight + (t.rank ?? 0.3) * 0.6
  if (s?.liked) v += 0.8
  if (s?.skips) v -= 1.5
  if (s?.completes) v += Math.min(1, s.completes * 0.2) * (o.familiarity ?? 0)
  if (o.familiarity && !s?.liked && !s?.completes) v += o.familiarity < 0 && !isFamiliarArtist(taste, t) ? 0.8 : 0
  if (!o.allowRecent && s?.last) {
    const ago = o.now - s.last
    if (ago < 2 * DAY) v -= 2
    else if (ago < 7 * DAY) v -= 0.7
  }
  return v + jitter(t.id, o.seed ?? 0) * 0.6
}

/**
 * Best first, but never the same artist twice within `gap` songs nor more than `perArtist` times, and each
 * song once (one song from two catalogs has one id).
 */
export function arrange (scored: Array<Candidate & { score: number }>, opts: { size: number; perArtist: number; gap: number }): Candidate[] {
  const pool = scored.filter(c => Number.isFinite(c.score)).sort((a, b) => b.score - a.score)
  const out: Candidate[] = []
  const used = new Set<string>()
  const count = new Map<string, number>()
  while (out.length < opts.size && pool.length) {
    const recent = new Set(out.slice(-opts.gap).map(c => c.track.artist.id))
    let i = pool.findIndex(c => !used.has(c.track.id) && !recent.has(c.track.artist.id) && (count.get(c.track.artist.id) ?? 0) < opts.perArtist)
    if (i < 0) {
      // Only crowded artists are left: relax the gap, never the cap.
      i = pool.findIndex(c => !used.has(c.track.id) && (count.get(c.track.artist.id) ?? 0) < opts.perArtist)
      if (i < 0) break
    }
    const [c] = pool.splice(i, 1)
    used.add(c.track.id)
    count.set(c.track.artist.id, (count.get(c.track.artist.id) ?? 0) + 1)
    out.push(c)
  }
  return out
}

/** Merges candidates for the same song: the best fit wins, and its reason with it. */
export function merge (lists: Candidate[][]): Candidate[] {
  const by = new Map<string, Candidate>()
  for (const list of lists) {
    for (const c of list) {
      const have = by.get(c.track.id)
      if (!have || c.fit > have.fit) by.set(c.track.id, have ? { ...c, fit: Math.min(1, c.fit + 0.1) } : c)
      else have.fit = Math.min(1, have.fit + 0.1)
    }
  }
  return [...by.values()]
}

/** Position in a list (radio, playlist, top songs) as fit: the first is 1, fading to `floor`. */
export const byPosition = (tracks: MusicTrack[], why: (t: MusicTrack) => string, floor = 0.2): Candidate[] =>
  tracks.map((track, i) => ({ track, fit: Math.max(floor, 1 - i / Math.max(10, tracks.length)), why: why(track) }))

/** "Arijit Singh, Pritam and Shreya Ghoshal" from the most frequent artists in a list. */
export function featuring (tracks: MusicTrack[], skip: string[] = [], max = 3): string {
  const n = new Map<string, { name: string; c: number }>()
  for (const t of tracks) {
    if (skip.includes(t.artist.id)) continue
    const e = n.get(t.artist.id) ?? { name: t.artist.name, c: 0 }
    e.c++
    n.set(t.artist.id, e)
  }
  const top = [...n.values()].sort((a, b) => b.c - a.c).slice(0, max).map(e => e.name)
  if (top.length <= 1) return top.join('')
  return `${top.slice(0, -1).join(', ')} and ${top.at(-1)}`
}
