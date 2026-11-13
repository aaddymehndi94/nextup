import { authenticate } from './auth.ts'
import { type Ctx, HttpError, json, readJson } from './http.ts'
import { cursorAhead, f, pageParams, SEQ } from './sync.ts'
import { LIMITS, MUSIC_SECTIONS, type MusicBatch, type MusicSection, parseMusicBatch } from './wire.ts'

// Music sync: the same model as films (sync.ts), on its own endpoints so that clients from before music never
// see these rows and new clients can tell whether a Worker has them (the film pull's musicHead). Likes are
// last-write-wins on updatedAt with 0 kept as "changed their mind", listens are insert-once by UUID, asked-for
// mixes are last-write-wins on `at`. Songs and artists are catalog facts shared by the account's rows: a push
// only fills their gaps, so re-sending one costs no write and moves no cursor. Rows take seqs from the
// account's one counter; accounts.music_seq marks the last music push.

const UPSERT: Record<MusicSection, string> = {
  artists: `INSERT INTO music_artists (account_id, id, name, picture, itunes_id, deezer_id, seq)
            SELECT ?1, ${f('id')}, ${f('name')}, ${f('picture')}, ${f('itunesId')}, ${f('deezerId')}, ${SEQ}
            FROM json_each(?2) AS j WHERE true
            ON CONFLICT (account_id, id) DO UPDATE SET
              picture = COALESCE(music_artists.picture, excluded.picture),
              itunes_id = COALESCE(music_artists.itunes_id, excluded.itunes_id),
              deezer_id = COALESCE(music_artists.deezer_id, excluded.deezer_id),
              seq = excluded.seq
            WHERE (music_artists.picture IS NULL AND excluded.picture IS NOT NULL)
               OR (music_artists.itunes_id IS NULL AND excluded.itunes_id IS NOT NULL)
               OR (music_artists.deezer_id IS NULL AND excluded.deezer_id IS NOT NULL)`,
  tracks: `INSERT INTO music_tracks (account_id, id, title, credit, artist_id, artist, picture, album_id, album, cover, duration, explicit, rank, seq)
           SELECT ?1, ${f('id')}, ${f('title')}, ${f('credit')}, ${f('artistId')}, ${f('artist')}, ${f('picture')}, ${f('albumId')}, ${f('album')},
                  ${f('cover')}, ${f('duration')}, ${f('explicit')}, ${f('rank')}, ${SEQ}
           FROM json_each(?2) AS j WHERE true
           ON CONFLICT (account_id, id) DO UPDATE SET
             credit = COALESCE(music_tracks.credit, excluded.credit),
             picture = COALESCE(music_tracks.picture, excluded.picture),
             album = CASE WHEN music_tracks.album_id IS NULL THEN excluded.album ELSE music_tracks.album END,
             album_id = COALESCE(music_tracks.album_id, excluded.album_id),
             cover = COALESCE(music_tracks.cover, excluded.cover),
             duration = CASE WHEN music_tracks.duration = 0 THEN excluded.duration ELSE music_tracks.duration END,
             explicit = MAX(music_tracks.explicit, excluded.explicit),
             rank = CASE WHEN music_tracks.rank = 0 THEN excluded.rank ELSE music_tracks.rank END,
             seq = excluded.seq
           WHERE (music_tracks.credit IS NULL AND excluded.credit IS NOT NULL)
              OR (music_tracks.picture IS NULL AND excluded.picture IS NOT NULL)
              OR (music_tracks.album_id IS NULL AND excluded.album_id IS NOT NULL)
              OR (music_tracks.cover IS NULL AND excluded.cover IS NOT NULL)
              OR (music_tracks.duration = 0 AND excluded.duration > 0)
              OR excluded.explicit > music_tracks.explicit
              OR (music_tracks.rank = 0 AND excluded.rank > 0)`,
  ratings: `INSERT INTO music_ratings (account_id, profile_id, kind, item_id, value, name, picture, updated_at, seq)
            SELECT ?1, ${f('profileId')}, ${f('kind')}, ${f('itemId')}, ${f('value')}, ${f('name')}, ${f('picture')}, ${f('updatedAt')}, ${SEQ}
            FROM json_each(?2) AS j WHERE true
            ON CONFLICT (account_id, profile_id, kind, item_id) DO UPDATE SET
              value = excluded.value, name = COALESCE(excluded.name, music_ratings.name), picture = COALESCE(excluded.picture, music_ratings.picture),
              updated_at = excluded.updated_at, seq = excluded.seq
            WHERE excluded.updated_at > music_ratings.updated_at`,
  listens: `INSERT INTO music_listens (account_id, id, profile_id, track_id, artist_id, played, outcome, at, seq)
            SELECT ?1, ${f('id')}, ${f('profileId')}, ${f('trackId')}, ${f('artistId')}, ${f('played')}, ${f('outcome')}, ${f('at')}, ${SEQ}
            FROM json_each(?2) AS j WHERE true
            ON CONFLICT (account_id, id) DO NOTHING`,
  // tracks is the validated array, re-serialised by json_extract: no field the validator didn't allow.
  mixes: `INSERT INTO music_mixes (account_id, id, profile_id, kind, title, subtitle, tracks, model, at, seq)
          SELECT ?1, ${f('id')}, ${f('profileId')}, ${f('kind')}, ${f('title')}, ${f('subtitle')}, ${f('tracks')}, ${f('model')}, ${f('at')}, ${SEQ}
          FROM json_each(?2) AS j WHERE true
          ON CONFLICT (account_id, id) DO UPDATE SET
            profile_id = excluded.profile_id, kind = excluded.kind, title = excluded.title, subtitle = excluded.subtitle,
            tracks = excluded.tracks, model = excluded.model, at = excluded.at, seq = excluded.seq
          WHERE excluded.at > music_mixes.at`,
}

/** Keeps the newest LIMITS.musicMixesPerProfile mixes of each profile a push touched. Binds ?1 account, ?2 rows, ?3 how many. */
const TRIM_MIXES = `DELETE FROM music_mixes WHERE account_id = ?1
  AND profile_id IN (SELECT DISTINCT json_extract(value, '$.profileId') FROM json_each(?2))
  AND id NOT IN (SELECT m.id FROM music_mixes AS m WHERE m.account_id = ?1 AND m.profile_id = music_mixes.profile_id ORDER BY m.at DESC, m.id DESC LIMIT ?3)`

export async function musicPush (ctx: Ctx): Promise<Response> {
  const { account } = await authenticate(ctx)
  const batch = parseMusicBatch(await readJson(ctx.req, LIMITS.pushBytes), ctx.now)
  const { env } = ctx
  const applied = Object.fromEntries(MUSIC_SECTIONS.map(s => [s, 0])) as Record<MusicSection, number>
  const n = MUSIC_SECTIONS.reduce((sum, s) => sum + batch[s].length, 0)
  if (n === 0) return json({ applied, musicHead: String((account as { music_seq?: number }).music_seq ?? 0), serverTime: ctx.now })

  // Every profile a row names must already be this account's: profiles travel in the film push, which the
  // client runs first.
  const referenced = new Set<string>()
  for (const s of ['ratings', 'listens', 'mixes'] as const) for (const r of batch[s]) referenced.add(r.profileId)
  if (referenced.size) {
    const found = await env.DB.prepare('SELECT id, account_id FROM profiles WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify([...referenced])).all<{ id: string; account_id: string }>()
    const owned = new Set<string>()
    for (const r of found.results) {
      if (r.account_id !== account.id) throw new HttpError(409, 'profile_conflict', `Profile ${r.id} belongs to another account`)
      owned.add(r.id)
    }
    for (const id of referenced) {
      if (!owned.has(id)) throw new HttpError(422, 'unknown_profile', `Profile ${id} isn't on this account yet; push it with /v1/sync/push first`)
    }
  }

  // One transaction, as for films: raise the counter by n (music_seq follows it), each row takes its slot.
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE accounts SET sync_seq = sync_seq + ?1, music_seq = sync_seq + ?1 WHERE id = ?2').bind(n, account.id),
  ]
  const index: MusicSection[] = []
  let off = 0
  for (const s of MUSIC_SECTIONS) {
    const rows = batch[s]
    if (!rows.length) continue
    const payload = JSON.stringify(rows)
    stmts.push(env.DB.prepare(UPSERT[s]).bind(account.id, payload, n - off))
    index.push(s)
    off += rows.length
  }
  if (batch.mixes.length) stmts.push(env.DB.prepare(TRIM_MIXES).bind(account.id, JSON.stringify(batch.mixes), LIMITS.musicMixesPerProfile))
  stmts.push(env.DB.prepare('SELECT music_seq FROM accounts WHERE id = ?').bind(account.id))
  const results = await env.DB.batch(stmts)
  index.forEach((s, i) => { applied[s] += results[i + 1].meta.changes ?? 0 })
  const head = (results[results.length - 1].results[0] as { music_seq: number }).music_seq
  return json({ applied, musicHead: String(head), serverTime: ctx.now })
}

type Row = Record<string, unknown> & { seq: number }

const OUT: { [S in MusicSection]: (r: Row) => MusicBatch[S][number] } = {
  artists: r => ({ id: r.id as string, name: r.name as string, picture: r.picture as string | null, itunesId: r.itunes_id as string | null, deezerId: r.deezer_id as string | null }),
  tracks: r => ({
    id: r.id as string, title: r.title as string, credit: r.credit as string | null, artistId: r.artist_id as string, artist: r.artist as string,
    picture: r.picture as string | null, albumId: r.album_id as string | null, album: r.album as string | null, cover: r.cover as string | null,
    duration: r.duration as number, explicit: r.explicit as 0 | 1, rank: r.rank as number,
  }),
  ratings: r => ({
    profileId: r.profile_id as string, kind: r.kind as 'track' | 'artist', itemId: r.item_id as string, value: r.value as -1 | 0 | 1,
    name: r.name as string | null, picture: r.picture as string | null, updatedAt: r.updated_at as number,
  }),
  listens: r => ({
    id: r.id as string, profileId: r.profile_id as string, trackId: r.track_id as string, artistId: r.artist_id as string,
    played: r.played as number, outcome: r.outcome as 'complete' | 'partial' | 'skip', at: r.at as number,
  }),
  mixes: r => ({
    id: r.id as string, profileId: r.profile_id as string, kind: r.kind as 'ai' | 'mood', title: r.title as string, subtitle: r.subtitle as string,
    tracks: JSON.parse(r.tracks as string), model: r.model as string | null, at: r.at as number,
  }),
}

/**
 * Like the film pull, with one difference: once a page reaches the end (`more` false), the cursor is the
 * account's counter at that snapshot, not the last row's seq. Everything up to it is in the snapshot, so a
 * client whose cursor is at or past the film pull's musicHead knows there's nothing new and skips this call.
 */
export async function musicPull (ctx: Ctx): Promise<Response> {
  const { account } = await authenticate(ctx)
  const { since, limit } = pageParams(ctx.url)
  const { env } = ctx
  const results = await env.DB.batch<Row | { sync_seq: number }>([
    env.DB.prepare('SELECT sync_seq FROM accounts WHERE id = ?').bind(account.id),
    ...MUSIC_SECTIONS.map(s => env.DB.prepare(`SELECT * FROM music_${s} WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`).bind(account.id, since, limit + 1)),
  ])
  const head = (results[0].results[0] as { sync_seq: number }).sync_seq
  if (since > head) throw cursorAhead()
  const all: Array<{ s: MusicSection; r: Row }> = []
  MUSIC_SECTIONS.forEach((s, i) => { for (const r of results[i + 1].results as Row[]) all.push({ s, r }) })
  all.sort((a, b) => a.r.seq - b.r.seq)
  const page = all.slice(0, limit)
  const more = all.length > limit
  const out = Object.fromEntries(MUSIC_SECTIONS.map(s => [s, [] as unknown[]])) as Record<MusicSection, unknown[]>
  for (const { s, r } of page) out[s].push(OUT[s](r))
  const cursor = more ? page[page.length - 1].r.seq : head
  return json({ cursor: String(cursor), more, serverTime: ctx.now, ...out })
}
