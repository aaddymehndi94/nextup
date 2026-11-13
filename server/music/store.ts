import type { DatabaseSync } from 'node:sqlite'
import type { MixKind, MusicArtist, MusicTrack } from '../../shared/music.ts'
import { transaction, uuidv7 } from '../db.ts'
import type { ArtistBook, ArtistRef } from './catalog.ts'

// The music tables (migration 4 in server/db.ts): songs and artists seen, listens, likes, and saved mixes.

export type Outcome = 'complete' | 'partial' | 'skip'

export interface ListenRow { trackId: string; artistId: string; artist: string; credit: string | null; title: string; played: number; outcome: Outcome; at: number }
export interface Ratings { tracks: Map<string, number>; artists: Map<string, number> }
export interface SavedMix { id: string; kind: MixKind; title: string; subtitle: string; tracks: Array<{ id: string; why?: string }>; model?: string | null; at: number }

interface TrackRow {
  id: string; title: string; credit: string | null; artist_id: string; artist: string; picture: string | null
  album_id: string | null; album: string | null; cover: string | null; duration: number; explicit: number; rank: number
}

const toTrack = (r: TrackRow): MusicTrack => ({
  id: r.id,
  title: r.title,
  artist: { id: r.artist_id, name: r.artist, ...(r.picture ? { picture: r.picture } : {}) },
  ...(r.credit ? { credit: r.credit } : {}),
  ...(r.album_id ? { album: { id: r.album_id, title: r.album ?? '', ...(r.cover ? { cover: r.cover } : {}) } } : {}),
  duration: Number(r.duration),
  ...(r.explicit ? { explicit: true } : {}),
  ...(r.rank ? { rank: Number(r.rank) } : {}),
})

/** How a listen counts: heard to the end, skipped early, or somewhere between. */
export function outcomeOf (played: number, duration: number, how: 'ended' | 'skipped' | 'left'): Outcome | null {
  if (how === 'ended' || (duration > 0 && played >= Math.max(30, duration * 0.8))) return 'complete'
  if (played < 30) return how === 'skipped' ? 'skip' : played >= 10 ? 'partial' : null
  return 'partial'
}

export class MusicStore implements ArtistBook {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor (db: DatabaseSync, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  // ---- Artists ----

  get (id: string): ArtistRef | null {
    const r = this.db.prepare('SELECT id, name, picture, itunes_id, deezer_id FROM music_artists WHERE id = ?').get(id) as
      { id: string; name: string; picture: string | null; itunes_id: string | null; deezer_id: string | null } | undefined
    return r ? { id: r.id, name: r.name, picture: r.picture ?? undefined, itunes: r.itunes_id ?? undefined, deezer: r.deezer_id ?? undefined } : null
  }

  put (a: ArtistRef): void {
    this.db.prepare(`INSERT INTO music_artists (id, name, picture, itunes_id, deezer_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET picture = COALESCE(excluded.picture, picture), itunes_id = COALESCE(excluded.itunes_id, itunes_id),
        deezer_id = COALESCE(excluded.deezer_id, deezer_id), seen_at = excluded.seen_at`)
      .run(a.id, a.name, a.picture ?? null, a.itunes ?? null, a.deezer ?? null, this.now())
  }

  artist (id: string): MusicArtist | null {
    const a = this.get(id)
    if (a) return { id: a.id, name: a.name, ...(a.picture ? { picture: a.picture } : {}) }
    const t = this.db.prepare('SELECT artist, picture FROM music_tracks WHERE artist_id = ? LIMIT 1').get(id) as { artist: string; picture: string | null } | undefined
    return t ? { id, name: t.artist, ...(t.picture ? { picture: t.picture } : {}) } : null
  }

  // ---- Songs ----

  /** Remembers songs as the catalogs describe them; the first description wins, gaps are filled later. */
  saveTracks (tracks: MusicTrack[]): void {
    if (!tracks.length) return
    const at = this.now()
    const stmt = this.db.prepare(`INSERT INTO music_tracks (id, title, credit, artist_id, artist, picture, album_id, album, cover, duration, explicit, rank, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        credit = COALESCE(credit, excluded.credit),
        picture = COALESCE(excluded.picture, picture),
        album_id = COALESCE(album_id, excluded.album_id),
        album = CASE WHEN album_id IS NULL THEN excluded.album ELSE album END,
        cover = COALESCE(cover, excluded.cover),
        duration = CASE WHEN duration = 0 THEN excluded.duration ELSE duration END,
        explicit = MAX(explicit, excluded.explicit),
        rank = MAX(rank, excluded.rank),
        seen_at = excluded.seen_at`)
    transaction(this.db, () => {
      for (const t of tracks) {
        stmt.run(t.id, t.title, t.credit ?? null, t.artist.id, t.artist.name, t.artist.picture ?? null, t.album?.id ?? null, t.album?.title ?? null,
          t.album?.cover ?? null, Math.round(t.duration || 0), t.explicit ? 1 : 0, t.rank ?? 0, at)
      }
    })
  }

  track (id: string): MusicTrack | null {
    const r = this.db.prepare('SELECT * FROM music_tracks WHERE id = ?').get(id) as TrackRow | undefined
    return r ? toTrack(r) : null
  }

  /** Songs by id, in the order asked, skipping any never seen. */
  tracks (ids: string[]): MusicTrack[] {
    if (!ids.length) return []
    const rows = new Map<string, MusicTrack>()
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400)
      const found = this.db.prepare(`SELECT * FROM music_tracks WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as TrackRow[]
      for (const r of found) rows.set(r.id, toTrack(r))
    }
    return ids.map(id => rows.get(id)).filter((t): t is MusicTrack => Boolean(t))
  }

  // ---- Listens ----

  listen (profileId: string, track: MusicTrack, played: number, how: 'ended' | 'skipped' | 'left'): Outcome | null {
    const outcome = outcomeOf(played, track.duration, how)
    if (!outcome) return null
    const at = this.now()
    this.db.prepare('INSERT INTO music_listens (id, profile_id, track_id, artist_id, played, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv7(at), profileId, track.id, track.artist.id, Math.round(played * 10) / 10, outcome, at)
    return outcome
  }

  history (profileId: string, since: number): ListenRow[] {
    return (this.db.prepare(`SELECT l.track_id, l.artist_id, t.artist, t.credit, t.title, l.played, l.outcome, l.at
      FROM music_listens l JOIN music_tracks t ON t.id = l.track_id WHERE l.profile_id = ? AND l.at >= ? ORDER BY l.at DESC LIMIT 5000`)
      .all(profileId, since) as Array<{ track_id: string; artist_id: string; artist: string; credit: string | null; title: string; played: number; outcome: Outcome; at: number }>)
      .map(r => ({ trackId: r.track_id, artistId: r.artist_id, artist: r.artist, credit: r.credit, title: r.title, played: Number(r.played), outcome: r.outcome, at: Number(r.at) }))
  }

  /** Songs heard lately, newest first, each once. */
  recent (profileId: string, limit: number): MusicTrack[] {
    const ids = (this.db.prepare(`SELECT track_id, MAX(at) AS last FROM music_listens WHERE profile_id = ? AND outcome != 'skip'
      GROUP BY track_id ORDER BY last DESC LIMIT ?`).all(profileId, limit) as Array<{ track_id: string }>).map(r => r.track_id)
    return this.tracks(ids)
  }

  listenCount (profileId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM music_listens WHERE profile_id = ?').get(profileId) as { n: number }).n)
  }

  // ---- Likes ----

  rate (profileId: string, kind: 'track' | 'artist', id: string, rating: 1 | -1 | 0, about?: { name?: string; picture?: string }): void {
    this.db.prepare(`INSERT INTO music_ratings (profile_id, kind, item_id, rating, name, picture, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (profile_id, kind, item_id) DO UPDATE SET rating = excluded.rating, name = COALESCE(excluded.name, name),
        picture = COALESCE(excluded.picture, picture), updated_at = excluded.updated_at`)
      .run(profileId, kind, id, rating, about?.name ?? null, about?.picture ?? null, this.now())
  }

  ratings (profileId: string): Ratings {
    const rows = this.db.prepare('SELECT kind, item_id, rating FROM music_ratings WHERE profile_id = ? AND rating != 0').all(profileId) as Array<{ kind: string; item_id: string; rating: number }>
    const out: Ratings = { tracks: new Map(), artists: new Map() }
    for (const r of rows) (r.kind === 'track' ? out.tracks : out.artists).set(r.item_id, Number(r.rating))
    return out
  }

  rating (profileId: string, kind: 'track' | 'artist', id: string): 1 | -1 | 0 {
    const r = this.db.prepare('SELECT rating FROM music_ratings WHERE profile_id = ? AND kind = ? AND item_id = ?').get(profileId, kind, id) as { rating: number } | undefined
    return (r ? Number(r.rating) : 0) as 1 | -1 | 0
  }

  liked (profileId: string, limit = 500): MusicTrack[] {
    const ids = (this.db.prepare("SELECT item_id FROM music_ratings WHERE profile_id = ? AND kind = 'track' AND rating = 1 ORDER BY updated_at DESC LIMIT ?")
      .all(profileId, limit) as Array<{ item_id: string }>).map(r => r.item_id)
    return this.tracks(ids)
  }

  likedCount (profileId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM music_ratings WHERE profile_id = ? AND kind = 'track' AND rating = 1").get(profileId) as { n: number }).n)
  }

  likedArtists (profileId: string): MusicArtist[] {
    return (this.db.prepare("SELECT item_id, name, picture FROM music_ratings WHERE profile_id = ? AND kind = 'artist' AND rating = 1 ORDER BY updated_at DESC")
      .all(profileId) as Array<{ item_id: string; name: string | null; picture: string | null }>)
      .map(r => this.artist(r.item_id) ?? { id: r.item_id, name: r.name ?? '', ...(r.picture ? { picture: r.picture } : {}) })
      .filter(a => a.name)
  }

  // ---- Mixes ----

  saveMix (profileId: string, mix: SavedMix): void {
    this.db.prepare(`INSERT INTO music_mixes (id, profile_id, kind, title, subtitle, tracks, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET title = excluded.title, subtitle = excluded.subtitle, tracks = excluded.tracks, model = excluded.model, at = excluded.at`)
      .run(mix.id, profileId, mix.kind, mix.title, mix.subtitle, JSON.stringify(mix.tracks), mix.model ?? null, mix.at)
  }

  mixes (profileId: string): SavedMix[] {
    return (this.db.prepare('SELECT id, kind, title, subtitle, tracks, model, at FROM music_mixes WHERE profile_id = ? ORDER BY at DESC')
      .all(profileId) as Array<{ id: string; kind: MixKind; title: string; subtitle: string; tracks: string; model: string | null; at: number }>)
      .map(r => ({ id: r.id, kind: r.kind, title: r.title, subtitle: r.subtitle, tracks: JSON.parse(r.tracks) as SavedMix['tracks'], model: r.model, at: Number(r.at) }))
  }

  mix (profileId: string, id: string): SavedMix | null {
    return this.mixes(profileId).find(m => m.id === id) ?? null
  }

  /** Drops this profile's engine mixes (made again on the next visit) and all but the newest few AI mixes. */
  dropMixes (profileId: string, kinds: MixKind[], keepAi = 6): void {
    if (kinds.length) this.db.prepare(`DELETE FROM music_mixes WHERE profile_id = ? AND kind IN (${kinds.map(() => '?').join(',')})`).run(profileId, ...kinds)
    this.db.prepare(`DELETE FROM music_mixes WHERE profile_id = ? AND kind IN ('ai', 'mood') AND id NOT IN (
      SELECT id FROM music_mixes WHERE profile_id = ? AND kind IN ('ai', 'mood') ORDER BY at DESC LIMIT ?)`).run(profileId, profileId, keepAi)
  }
}
