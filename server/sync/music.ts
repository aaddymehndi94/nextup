import type { DatabaseSync } from 'node:sqlite'
import { ALBUM_ID, CATALOG_ID, catalogText, imageUrl, TRACK_ID } from '../../cloud/src/validate.ts'
import {
  LIMITS, MIX_TRACKS_MAX, type MusicArtistW, type MusicBatch, type MusicListenW, type MusicMixW, type MusicRatingW, MUSIC_SECTIONS, MUSIC_TEXT,
  MUSIC_VALIDATORS, type MusicSection, type MusicTrackW,
} from '../../cloud/src/wire.ts'
import { muted } from './local.ts'

// Music sync, the database side (cloud/README.md, "Music"): what to push from `sync_music_outbox`
// (migration 5 in server/db.ts), and how pulled rows merge in. It syncs a profile's likes, listens and the
// mixes they asked for (AI and mood), and with them the songs and artists those rows name, so another
// computer can show them and build artist mixes. Engine mixes, music_files and AI settings stay here.
// service.ts runs this after the film push and pull, and only when the cloud says it syncs music.

type Row = Record<string, string | number | null>

export const emptyMusicBatch = (): MusicBatch => ({ artists: [], tracks: [], ratings: [], listens: [], mixes: [] })

// ---- Local row → wire --------------------------------------------------------------------
// Optional details the cloud wouldn't take (a picture from another host, an over-long credit) are left out
// rather than holding the row back; a row without its required text isn't sent at all.

const ok = <T>(f: () => T): T | null => { try { return f() } catch { return null } }
const clip = (v: unknown, max: number) => [...String(v)].slice(0, max).join('').trim()
const text = (v: unknown, max: number): string | null => (v === null || v === undefined ? null : ok(() => catalogText(clip(v, max), 'text', max)))
const picture = (v: unknown): string | null => (typeof v === 'string' ? ok(() => imageUrl(v, 'picture')) : null)
const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0))
const catalogId = (v: unknown) => (v !== null && CATALOG_ID.test(String(v)) ? String(v) : null)

export function artistWire (r: Row): MusicArtistW | null {
  const name = text(r.name, MUSIC_TEXT.name)
  if (!name) return null
  return { id: String(r.id), name, picture: picture(r.picture), itunesId: catalogId(r.itunes_id), deezerId: catalogId(r.deezer_id) }
}

export function trackWire (r: Row): MusicTrackW | null {
  const title = text(r.title, MUSIC_TEXT.name)
  const artist = text(r.artist, MUSIC_TEXT.name)
  if (!title || !artist) return null
  const albumId = r.album_id !== null && ALBUM_ID.test(String(r.album_id)) ? String(r.album_id) : null
  return {
    id: String(r.id), title, credit: text(r.credit, MUSIC_TEXT.credit), artistId: String(r.artist_id), artist, picture: picture(r.picture),
    albumId, album: text(r.album, MUSIC_TEXT.name), cover: picture(r.cover),
    duration: Math.round(clamp(r.duration, 0, 86_400)), explicit: Number(r.explicit) ? 1 : 0, rank: clamp(r.rank, 0, 1),
  }
}

function ratingWire (r: Row): MusicRatingW {
  return {
    profileId: String(r.profile_id), kind: r.kind as MusicRatingW['kind'], itemId: String(r.item_id), value: Number(r.rating) as MusicRatingW['value'],
    name: text(r.name, MUSIC_TEXT.name), picture: picture(r.picture), updatedAt: Number(r.updated_at),
  }
}

function listenWire (r: Row): MusicListenW {
  return {
    id: String(r.id), profileId: String(r.profile_id), trackId: String(r.track_id), artistId: String(r.artist_id),
    played: Math.round(clamp(r.played, 0, 86_400) * 10) / 10, outcome: r.outcome as MusicListenW['outcome'], at: Number(r.at),
  }
}

function mixWire (r: Row): MusicMixW | null {
  let list: Array<{ id?: unknown; why?: unknown }> = []
  try { list = JSON.parse(String(r.tracks)) } catch { /* unreadable: sent without songs, so refused below */ }
  const tracks = (Array.isArray(list) ? list : []).filter(t => typeof t?.id === 'string' && TRACK_ID.test(t.id)).slice(0, MIX_TRACKS_MAX)
    .map(t => ({ id: String(t.id), why: t.why ? text(t.why, MUSIC_TEXT.why) : null }))
  const title = text(r.title, MUSIC_TEXT.mixTitle)
  const subtitle = text(r.subtitle, MUSIC_TEXT.mixSubtitle)
  if (!title || !subtitle || !tracks.length) return null
  return {
    id: String(r.id), profileId: String(r.profile_id), kind: r.kind as MusicMixW['kind'], title, subtitle, tracks,
    model: text(r.model, MUSIC_TEXT.model), at: Number(r.at),
  }
}

// ---- Push --------------------------------------------------------------------------------

/** The outbox's table names for the three queued sections. */
const QUEUED: Record<string, 'ratings' | 'listens' | 'mixes'> = { music_ratings: 'ratings', music_listens: 'listens', music_mixes: 'mixes' }

export interface MusicOutgoing {
  batch: MusicBatch
  /** Outbox ids this batch carries; cleared by ackMusicPush once the cloud has them. */
  ids: number[]
  /** For each row, the outbox id it came from; null for a song or artist sent because a row names it. */
  origin: Record<MusicSection, Array<number | null>>
  /** For each row, its id (songs and artists) or null, so a refused song can be skipped next time. */
  ref: Record<MusicSection, Array<string | null>>
}

type ProfileState = 'mine' | 'wait' | 'other' | 'drop'

/**
 * The next music push for `accountId`, or null when there's nothing to send. Each row brings the songs and
 * artists it names (once per batch). Rows wait while their profile isn't on the cloud yet (the film push
 * carries profiles); rows of another account's profile stay for that account; rows of deleted profiles and
 * rows the cloud would refuse are dropped. `skip` holds song and artist ids the cloud refused this run.
 */
export function collectMusicPush (db: DatabaseSync, accountId: string, now: number, opts: { maxRows?: number; maxBytes?: number; log?: (msg: string) => void; skip?: Set<string> } = {}): MusicOutgoing | null {
  const maxRows = opts.maxRows ?? LIMITS.pushItems
  const maxBytes = opts.maxBytes ?? 200 * 1024
  const log = opts.log ?? (() => {})
  const skip = opts.skip ?? new Set<string>()
  const batch = emptyMusicBatch()
  const origin = Object.fromEntries(MUSIC_SECTIONS.map(s => [s, []])) as unknown as MusicOutgoing['origin']
  const ref = Object.fromEntries(MUSIC_SECTIONS.map(s => [s, []])) as unknown as MusicOutgoing['ref']
  const ids: number[] = []
  const drop: number[] = []
  const states = new Map<string, ProfileState>()
  const included = new Set<string>()
  const details = new Map<string, MusicTrackW | MusicArtistW | null>()
  let rows = 0
  let bytes = 64

  const valid = (s: MusicSection, w: unknown): boolean => {
    try { MUSIC_VALIDATORS[s](w, s, now); return true } catch (err) { log(`sync: not syncing a music ${s} row: ${(err as Error).message}`); return false }
  }

  function stateOf (pid: string): ProfileState {
    let st = states.get(pid)
    if (st) return st
    const p = db.prepare('SELECT account_id, deleted_at FROM profiles WHERE id = ?').get(pid) as { account_id: string | null; deleted_at: number | null } | undefined
    if (!p) st = 'drop'
    else if (p.account_id !== null && p.account_id !== accountId) st = 'other'
    // Rows of a deleted profile stay home, as for films.
    else if (p.deleted_at !== null) st = 'drop'
    else if (p.account_id === null) {
      // Joins the account with the next film push (which carries profiles); its music follows after.
      db.prepare("INSERT OR IGNORE INTO sync_outbox (tbl, k1, k2) VALUES ('profiles', ?, '')").run(pid)
      st = 'wait'
    } else st = db.prepare("SELECT 1 FROM sync_outbox WHERE tbl = 'profiles' AND k1 = ?").get(pid) ? 'wait' : 'mine'
    states.set(pid, st)
    return st
  }

  /** A song or artist as the cloud would take it, or null (unknown here, refused before, or not valid). */
  function detail (s: 'tracks' | 'artists', id: string): MusicTrackW | MusicArtistW | null {
    if (details.has(id)) return details.get(id)!
    let w: MusicTrackW | MusicArtistW | null = null
    if (!skip.has(id)) {
      const r = db.prepare(`SELECT * FROM ${s === 'tracks' ? 'music_tracks' : 'music_artists'} WHERE id = ?`).get(id) as Row | undefined
      w = r ? (s === 'tracks' ? trackWire(r) : artistWire(r)) : null
      if (w && !valid(s, w)) w = null
    }
    details.set(id, w)
    return w
  }

  /** The songs and artists a row names that this batch doesn't carry yet. */
  function refsOf (s: 'ratings' | 'listens' | 'mixes', w: MusicRatingW | MusicListenW | MusicMixW): Array<['tracks' | 'artists', MusicTrackW | MusicArtistW]> {
    const trackIds: string[] = []
    const artistIds: string[] = []
    if (s === 'ratings') ((w as MusicRatingW).kind === 'track' ? trackIds : artistIds).push((w as MusicRatingW).itemId)
    else if (s === 'listens') { trackIds.push((w as MusicListenW).trackId); artistIds.push((w as MusicListenW).artistId) }
    else trackIds.push(...(w as MusicMixW).tracks.map(t => t.id))
    const out: Array<['tracks' | 'artists', MusicTrackW | MusicArtistW]> = []
    const seen = new Set<string>()
    for (const id of trackIds) {
      if (included.has(id) || seen.has(id)) continue
      seen.add(id)
      const t = detail('tracks', id) as MusicTrackW | null
      if (t) { out.push(['tracks', t]); artistIds.push(t.artistId) }
    }
    for (const id of artistIds) {
      if (included.has(id) || seen.has(id)) continue
      seen.add(id)
      const a = detail('artists', id)
      if (a) out.push(['artists', a])
    }
    return out
  }

  /** Adds a row and the details it names, all or nothing. */
  function add (s: MusicSection, w: MusicBatch[MusicSection][number], from: number, refs: Array<['tracks' | 'artists', MusicTrackW | MusicArtistW]>): boolean {
    const items: Array<[MusicSection, unknown, number | null, string | null]> = [...refs.map(([rs, r]) => [rs, r, null, r.id] as [MusicSection, unknown, null, string]), [s, w, from, null]]
    const size = items.reduce((n, [, r]) => n + JSON.stringify(r).length + 1, 0)
    if (rows + items.length > maxRows || bytes + size > maxBytes) return false
    for (const [rs, r, o, id] of items) {
      (batch[rs] as unknown[]).push(r)
      origin[rs].push(o)
      ref[rs].push(id)
      if (id) included.add(id)
    }
    rows += items.length
    bytes += size
    return true
  }

  const load = (tbl: string, k1: string, k2: string): Row | undefined => {
    if (tbl === 'music_ratings') {
      const i = k2.indexOf(':')
      return db.prepare('SELECT * FROM music_ratings WHERE profile_id = ? AND kind = ? AND item_id = ?').get(k1, k2.slice(0, i), k2.slice(i + 1)) as Row | undefined
    }
    if (tbl === 'music_listens') return db.prepare('SELECT * FROM music_listens WHERE id = ?').get(k1) as Row | undefined
    return db.prepare("SELECT * FROM music_mixes WHERE id = ? AND kind IN ('ai', 'mood')").get(k1) as Row | undefined
  }

  let after = 0
  scan: for (;;) {
    const entries = db.prepare('SELECT id, tbl, k1, k2 FROM sync_music_outbox WHERE id > ? ORDER BY id LIMIT 500').all(after) as Array<{ id: number; tbl: string; k1: string; k2: string }>
    if (!entries.length) break
    for (const e of entries) {
      after = e.id
      const s = QUEUED[e.tbl]
      const r = s ? load(e.tbl, e.k1, e.k2) : undefined
      if (!s || !r) { drop.push(e.id); continue }
      const st = stateOf(String(r.profile_id))
      if (st === 'other' || st === 'wait') continue
      if (st === 'drop') { drop.push(e.id); continue }
      const w = s === 'ratings' ? ratingWire(r) : s === 'listens' ? listenWire(r) : mixWire(r)
      if (!w || !valid(s, w)) { drop.push(e.id); continue }
      if (!add(s, w, e.id, refsOf(s, w))) {
        if (rows === 0) { log('sync: a music row is too big to sync; skipping it'); drop.push(e.id); continue }
        break scan
      }
      ids.push(e.id)
    }
  }
  if (drop.length) db.prepare('DELETE FROM sync_music_outbox WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(drop))
  return ids.length ? { batch, ids, origin, ref } : null
}

/** The cloud has these rows: clear their outbox entries (unless they were written again meanwhile). */
export function ackMusicPush (db: DatabaseSync, ids: number[]): void {
  db.prepare('DELETE FROM sync_music_outbox WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids))
}

/** Sets one music outbox entry aside for good (a row the cloud refused). */
export function dropMusicOutbox (db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM sync_music_outbox WHERE id = ?').run(id)
}

/** The cloud doesn't know some of these profiles: queue them for the next film push. */
export function requeueProfiles (db: DatabaseSync, profileIds: Iterable<string>): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO sync_outbox (tbl, k1, k2) SELECT 'profiles', id, '' FROM profiles WHERE id = ? AND deleted_at IS NULL")
  for (const id of profileIds) stmt.run(id)
}

export function musicPendingCount (db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM sync_music_outbox').get() as { n: number }).n)
}

// ---- Pull --------------------------------------------------------------------------------

// Songs and artists fill gaps in what this computer knows and never overwrite it. Likes take the pulled row
// when its updatedAt is at least the local one (the cloud breaks ties, as for films), mixes likewise on `at`,
// and listens are inserted once by id.
const APPLY: Record<MusicSection, string> = {
  artists: `INSERT INTO music_artists (id, name, picture, itunes_id, deezer_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET picture = COALESCE(music_artists.picture, excluded.picture),
              itunes_id = COALESCE(music_artists.itunes_id, excluded.itunes_id), deezer_id = COALESCE(music_artists.deezer_id, excluded.deezer_id)
            WHERE (music_artists.picture IS NULL AND excluded.picture IS NOT NULL) OR (music_artists.itunes_id IS NULL AND excluded.itunes_id IS NOT NULL)
              OR (music_artists.deezer_id IS NULL AND excluded.deezer_id IS NOT NULL)`,
  tracks: `INSERT INTO music_tracks (id, title, credit, artist_id, artist, picture, album_id, album, cover, duration, explicit, rank, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             credit = COALESCE(music_tracks.credit, excluded.credit),
             picture = COALESCE(music_tracks.picture, excluded.picture),
             album = CASE WHEN music_tracks.album_id IS NULL THEN excluded.album ELSE music_tracks.album END,
             album_id = COALESCE(music_tracks.album_id, excluded.album_id),
             cover = COALESCE(music_tracks.cover, excluded.cover),
             duration = CASE WHEN music_tracks.duration = 0 THEN excluded.duration ELSE music_tracks.duration END,
             explicit = MAX(music_tracks.explicit, excluded.explicit),
             rank = MAX(music_tracks.rank, excluded.rank)`,
  ratings: `INSERT INTO music_ratings (profile_id, kind, item_id, rating, name, picture, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (profile_id, kind, item_id) DO UPDATE SET rating = excluded.rating, name = COALESCE(excluded.name, music_ratings.name),
              picture = COALESCE(excluded.picture, music_ratings.picture), updated_at = excluded.updated_at
            WHERE excluded.updated_at >= music_ratings.updated_at`,
  listens: 'INSERT OR IGNORE INTO music_listens (id, profile_id, track_id, artist_id, played, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  mixes: `INSERT INTO music_mixes (id, profile_id, kind, title, subtitle, tracks, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET profile_id = excluded.profile_id, kind = excluded.kind, title = excluded.title, subtitle = excluded.subtitle,
            tracks = excluded.tracks, model = excluded.model, at = excluded.at
          WHERE excluded.at >= music_mixes.at`,
}

function applyArgs (s: MusicSection, w: MusicBatch[MusicSection][number], now: number): Array<string | number | null> {
  switch (s) {
    case 'artists': { const a = w as MusicArtistW; return [a.id, a.name, a.picture, a.itunesId, a.deezerId, now] }
    case 'tracks': {
      const t = w as MusicTrackW
      return [t.id, t.title, t.credit, t.artistId, t.artist, t.picture, t.albumId, t.album, t.cover, t.duration, t.explicit, t.rank, now]
    }
    case 'ratings': { const r = w as MusicRatingW; return [r.profileId, r.kind, r.itemId, r.value, r.name, r.picture, r.updatedAt] }
    case 'listens': { const l = w as MusicListenW; return [l.id, l.profileId, l.trackId, l.artistId, l.played, l.outcome, l.at] }
    case 'mixes': {
      const m = w as MusicMixW
      const tracks = JSON.stringify(m.tracks.map(t => (t.why ? { id: t.id, why: t.why } : { id: t.id })))
      return [m.id, m.profileId, m.kind, m.title, m.subtitle, tracks, m.model, m.at]
    }
  }
}

/** Merges a pulled music page into the local tables without queueing it for pushing. Returns how many rows changed. */
export function applyMusicPull (db: DatabaseSync, batch: Partial<MusicBatch>, now: number): number {
  let changed = 0
  muted(db, () => {
    for (const s of MUSIC_SECTIONS) {
      const stmt = db.prepare(APPLY[s])
      for (const w of (batch[s] ?? []) as Array<MusicBatch[MusicSection][number]>) changed += Number(stmt.run(...applyArgs(s, w, now)).changes)
    }
  })
  return changed
}
