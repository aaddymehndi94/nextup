import { authenticate } from './auth.ts'
import { bad, type Ctx, HttpError, json, readJson } from './http.ts'
import { int } from './validate.ts'
import { type Batch, type DismissalW, type EventContextW, type EventW, type Kind, LIMITS, type MediaType, parseBatch, SECTIONS, type Section } from './wire.ts'

// Taste sync, local-first. Clients push immutable events (insert-once by UUID) and current-state rows
// (last-write-wins on updatedAt, removals as tombstones), and pull everything that changed after a
// server-assigned cursor. Validation and the wire types are in wire.ts; the format is in README.md.

export { LIMITS }

// ---- Push ---------------------------------------------------------------------------------

/** seq for row j of a section: the account's counter was raised by `n` first, rows take the slots after `off`. */
const SEQ = '(SELECT sync_seq FROM accounts WHERE id = ?1) - ?3 + j.key + 1'
const f = (k: string) => `json_extract(j.value, '$.${k}')`

// Every statement binds ?1 = account id, ?2 = the section's rows as JSON, ?3 = n - off.
const UPSERT: Record<Section, string> = {
  // Deletion is sticky: a tombstone wins even if older, keeping the newer name and updatedAt.
  profiles: `INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at, deleted_at, seq)
             SELECT ${f('id')}, ?1, ${f('name')}, ${f('avatar')}, ${f('createdAt')}, ${f('updatedAt')}, ${f('deletedAt')}, ${SEQ}
             FROM json_each(?2) AS j WHERE true
             ON CONFLICT (id) DO UPDATE SET
               name = CASE WHEN excluded.updated_at > profiles.updated_at THEN excluded.name ELSE profiles.name END,
               avatar = CASE WHEN excluded.updated_at > profiles.updated_at THEN excluded.avatar ELSE profiles.avatar END,
               created_at = MIN(profiles.created_at, excluded.created_at),
               updated_at = MAX(profiles.updated_at, excluded.updated_at),
               deleted_at = COALESCE(profiles.deleted_at, excluded.deleted_at),
               seq = excluded.seq
             WHERE profiles.account_id = excluded.account_id
               AND (excluded.updated_at > profiles.updated_at OR (excluded.deleted_at IS NOT NULL AND profiles.deleted_at IS NULL))`,
  events: `INSERT INTO events (account_id, id, profile_id, kind, item_id, item_type, value, at, stream_id, position, duration, watched_sec, source, reason, feature, seq)
           SELECT ?1, ${f('id')}, ${f('profileId')}, ${f('kind')}, ${f('itemId')}, ${f('itemType')}, ${f('value')}, ${f('at')}, ${f('streamId')},
                  ${f('position')}, ${f('duration')}, ${f('watchedSec')}, ${f('source')}, ${f('reason')}, ${f('feature')}, ${SEQ}
           FROM json_each(?2) AS j WHERE true
           ON CONFLICT (account_id, id) DO NOTHING`,
  ratings: `INSERT INTO ratings (account_id, profile_id, item_id, item_type, value, source, updated_at, seq)
            SELECT ?1, ${f('profileId')}, ${f('itemId')}, ${f('itemType')}, ${f('value')}, ${f('source')}, ${f('updatedAt')}, ${SEQ}
            FROM json_each(?2) AS j WHERE true
            ON CONFLICT (account_id, profile_id, item_id) DO UPDATE SET
              item_type = excluded.item_type, value = excluded.value, source = excluded.source, updated_at = excluded.updated_at, seq = excluded.seq
            WHERE excluded.updated_at > ratings.updated_at`,
  list: `INSERT INTO my_list (account_id, profile_id, item_id, item_type, in_list, added_at, updated_at, seq)
         SELECT ?1, ${f('profileId')}, ${f('itemId')}, ${f('itemType')}, ${f('inList')}, ${f('addedAt')}, ${f('updatedAt')}, ${SEQ}
         FROM json_each(?2) AS j WHERE true
         ON CONFLICT (account_id, profile_id, item_id) DO UPDATE SET
           item_type = excluded.item_type, in_list = excluded.in_list, added_at = excluded.added_at, updated_at = excluded.updated_at, seq = excluded.seq
         WHERE excluded.updated_at > my_list.updated_at`,
  // Last write wins, except within one viewing (neither row forgotten, and the newer one started before the
  // stored row's last write): max_position and watched_sec take the max, and completion is sticky. A newer
  // row without completedAt keeps the stored one if it started before that completion. PROGRESS_MERGE
  // handles the older-row direction.
  progress: `INSERT INTO progress (account_id, profile_id, stream_id, item_id, item_type, season, episode, position, duration, max_position,
                                   watched_sec, completed_at, started_at, updated_at, hidden, forgotten, seq)
             SELECT ?1, ${f('profileId')}, ${f('streamId')}, ${f('itemId')}, ${f('itemType')}, ${f('season')}, ${f('episode')}, ${f('position')},
                    ${f('duration')}, ${f('maxPosition')}, ${f('watchedSec')}, ${f('completedAt')}, ${f('startedAt')}, ${f('updatedAt')},
                    ${f('hidden')}, ${f('forgotten')}, ${SEQ}
             FROM json_each(?2) AS j WHERE true
             ON CONFLICT (account_id, profile_id, stream_id) DO UPDATE SET
               item_id = excluded.item_id, item_type = excluded.item_type, season = excluded.season, episode = excluded.episode,
               position = excluded.position, duration = excluded.duration,
               max_position = CASE WHEN excluded.forgotten = 0 AND progress.forgotten = 0 AND excluded.started_at <= progress.updated_at
                                   THEN MAX(excluded.max_position, progress.max_position) ELSE excluded.max_position END,
               watched_sec = CASE WHEN excluded.forgotten = 0 AND progress.forgotten = 0 AND excluded.started_at <= progress.updated_at
                                  THEN MAX(excluded.watched_sec, progress.watched_sec) ELSE excluded.watched_sec END,
               completed_at = CASE
                 WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at
                 WHEN excluded.forgotten = 0 AND progress.forgotten = 0 AND progress.completed_at IS NOT NULL
                      AND excluded.started_at <= progress.completed_at THEN progress.completed_at
                 ELSE NULL END,
               started_at = excluded.started_at, updated_at = excluded.updated_at, hidden = excluded.hidden, forgotten = excluded.forgotten,
               seq = excluded.seq
             WHERE excluded.updated_at > progress.updated_at`,
  dismissals: `INSERT INTO dismissals (account_id, profile_id, item_id, item_type, reason, updated_at, seq)
               SELECT ?1, ${f('profileId')}, ${f('itemId')}, ${f('itemType')}, ${f('reason')}, ${f('updatedAt')}, ${SEQ}
               FROM json_each(?2) AS j WHERE true
               ON CONFLICT (account_id, profile_id, item_id) DO UPDATE SET
                 item_type = excluded.item_type, reason = excluded.reason, updated_at = excluded.updated_at, seq = excluded.seq
               WHERE excluded.updated_at > dismissals.updated_at`,
  prefs: `INSERT INTO feature_prefs (account_id, profile_id, feature, value, updated_at, seq)
          SELECT ?1, ${f('profileId')}, ${f('feature')}, ${f('value')}, ${f('updatedAt')}, ${SEQ}
          FROM json_each(?2) AS j WHERE true
          ON CONFLICT (account_id, profile_id, feature) DO UPDATE SET
            value = excluded.value, updated_at = excluded.updated_at, seq = excluded.seq
          WHERE excluded.updated_at > feature_prefs.updated_at`,
}

/**
 * An older row that lost on updatedAt still contributes its monotonic parts when it belongs to the same
 * viewing (neither forgotten, and the stored viewing had started when it was written): the larger
 * max_position and watched_sec, and its completion if the stored row has none. Changes nothing (and takes
 * no new seq) when it has nothing to add, so re-pushes stay idempotent.
 */
const J = { updatedAt: f('updatedAt'), completedAt: f('completedAt'), maxPosition: f('maxPosition'), watchedSec: f('watchedSec') }
const COMPLETES = `(progress.completed_at IS NULL AND ${J.completedAt} IS NOT NULL AND progress.started_at <= ${J.completedAt})`
const PROGRESS_MERGE = `UPDATE progress SET
    completed_at = CASE WHEN ${COMPLETES} THEN ${J.completedAt} ELSE progress.completed_at END,
    max_position = MAX(progress.max_position, ${J.maxPosition}),
    watched_sec = MAX(progress.watched_sec, ${J.watchedSec}),
    seq = ${SEQ}
  FROM json_each(?2) AS j
  WHERE progress.account_id = ?1 AND progress.profile_id = ${f('profileId')} AND progress.stream_id = ${f('streamId')}
    AND ${J.updatedAt} < progress.updated_at AND ${f('forgotten')} = 0 AND progress.forgotten = 0
    AND progress.started_at <= ${J.updatedAt}
    AND (${COMPLETES} OR ${J.maxPosition} > progress.max_position OR ${J.watchedSec} > progress.watched_sec)`

/** Events are stored flat, in typed columns; context is rebuilt on pull. */
const flatEvent = (e: EventW) => ({
  id: e.id, profileId: e.profileId, kind: e.kind, itemId: e.itemId, itemType: e.itemType, value: e.value, at: e.at,
  streamId: e.context?.streamId ?? null, position: e.context?.position ?? null, duration: e.context?.duration ?? null,
  watchedSec: e.context?.watchedSec ?? null, source: e.context?.source ?? null, reason: e.context?.reason ?? null, feature: e.context?.feature ?? null,
})

export async function push (ctx: Ctx): Promise<Response> {
  const { account } = await authenticate(ctx)
  const batch = parseBatch(await readJson(ctx.req, LIMITS.pushBytes), ctx.now)
  const { env } = ctx
  const applied = Object.fromEntries(SECTIONS.map(s => [s, 0])) as Record<Section, number>
  const n = SECTIONS.reduce((sum, s) => sum + batch[s].length, 0)
  if (n === 0) return json({ applied, serverTime: ctx.now })

  // Every profile a row refers to must be this account's, already or in this push.
  const pushed = new Set(batch.profiles.map(p => p.id))
  const referenced = new Set<string>()
  for (const s of SECTIONS) if (s !== 'profiles') for (const r of batch[s] as Array<{ profileId: string }>) referenced.add(r.profileId)
  const ids = [...new Set([...pushed, ...referenced])]
  const [found, count] = await env.DB.batch<{ id: string; account_id: string } | { n: number }>([
    env.DB.prepare('SELECT id, account_id FROM profiles WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)),
    env.DB.prepare('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?').bind(account.id),
  ])
  const owned = new Set<string>()
  for (const r of found.results as Array<{ id: string; account_id: string }>) {
    if (r.account_id !== account.id) throw new HttpError(409, 'profile_conflict', `Profile ${r.id} belongs to another account`)
    owned.add(r.id)
  }
  for (const id of referenced) {
    if (!owned.has(id) && !pushed.has(id)) throw new HttpError(422, 'unknown_profile', `Profile ${id} isn't on this account yet; push it in "profiles" first or in the same request`)
  }
  const added = [...pushed].filter(id => !owned.has(id)).length
  if (((count.results[0] as { n: number }).n) + added > LIMITS.profilesPerAccount) {
    throw new HttpError(409, 'too_many_profiles', `An account can hold at most ${LIMITS.profilesPerAccount} profiles, deleted ones included`)
  }

  // One transaction: raise the account's counter by n, then each row takes its own slot in (old, old + n].
  // Pulls see all of a push or none of it, and its seqs are above anything committed before.
  const stmts: D1PreparedStatement[] = [env.DB.prepare('UPDATE accounts SET sync_seq = sync_seq + ? WHERE id = ?').bind(n, account.id)]
  const index: Array<Section> = []
  let off = 0
  for (const s of SECTIONS) {
    const rows = batch[s]
    if (!rows.length) continue
    const payload = JSON.stringify(s === 'events' ? (rows as EventW[]).map(flatEvent) : rows)
    stmts.push(env.DB.prepare(UPSERT[s]).bind(account.id, payload, n - off))
    index.push(s)
    if (s === 'progress') {
      stmts.push(env.DB.prepare(PROGRESS_MERGE).bind(account.id, payload, n - off))
      index.push(s)
    }
    off += rows.length
  }
  const results = await env.DB.batch(stmts)
  results.slice(1).forEach((r, i) => { applied[index[i]] += r.meta.changes ?? 0 })
  return json({ applied, serverTime: ctx.now })
}

// ---- Pull ---------------------------------------------------------------------------------

type Row = Record<string, unknown> & { seq: number }

const TABLE: Record<Section, string> = {
  profiles: 'profiles', events: 'events', ratings: 'ratings', list: 'my_list', progress: 'progress', dismissals: 'dismissals', prefs: 'feature_prefs',
}

const OUT: { [S in Section]: (r: Row) => Batch[S][number] } = {
  profiles: r => ({ id: r.id as string, name: r.name as string, avatar: r.avatar as string | null, createdAt: r.created_at as number, updatedAt: r.updated_at as number, deletedAt: r.deleted_at as number | null }),
  events: r => {
    const context: EventContextW = {}
    for (const [k, col] of [['streamId', 'stream_id'], ['position', 'position'], ['duration', 'duration'], ['watchedSec', 'watched_sec'], ['source', 'source'], ['reason', 'reason'], ['feature', 'feature']] as const) {
      if (r[col] !== null && r[col] !== undefined) (context as Record<string, unknown>)[k] = r[col]
    }
    return {
      id: r.id as string, profileId: r.profile_id as string, kind: r.kind as Kind, itemId: r.item_id as string | null, itemType: r.item_type as MediaType | null,
      value: r.value as number | null, context: Object.keys(context).length ? context : null, at: r.at as number,
    }
  },
  ratings: r => ({ profileId: r.profile_id as string, itemId: r.item_id as string, itemType: r.item_type as MediaType, value: r.value as -1 | 0 | 1, source: r.source as string | null, updatedAt: r.updated_at as number }),
  list: r => ({ profileId: r.profile_id as string, itemId: r.item_id as string, itemType: r.item_type as MediaType, inList: r.in_list as 0 | 1, addedAt: r.added_at as number, updatedAt: r.updated_at as number }),
  progress: r => ({
    profileId: r.profile_id as string, streamId: r.stream_id as string, itemId: r.item_id as string, itemType: r.item_type as MediaType,
    season: r.season as number | null, episode: r.episode as number | null, position: r.position as number, duration: r.duration as number,
    maxPosition: r.max_position as number, watchedSec: r.watched_sec as number, completedAt: r.completed_at as number | null,
    startedAt: r.started_at as number, updatedAt: r.updated_at as number, hidden: r.hidden as 0 | 1, forgotten: r.forgotten as 0 | 1,
  }),
  dismissals: r => ({ profileId: r.profile_id as string, itemId: r.item_id as string, itemType: r.item_type as MediaType, reason: r.reason as DismissalW['reason'], updatedAt: r.updated_at as number }),
  prefs: r => ({ profileId: r.profile_id as string, feature: r.feature as string, value: r.value as -1 | 0 | 1, updatedAt: r.updated_at as number }),
}

export async function pull (ctx: Ctx): Promise<Response> {
  const { account } = await authenticate(ctx)
  const q = ctx.url.searchParams
  for (const k of q.keys()) if (k !== 'since' && k !== 'limit') throw bad(`query: unknown parameter "${k}"`)
  const sinceS = q.get('since') ?? '0'
  if (!/^\d{1,15}$/.test(sinceS)) throw bad('since: must be a cursor returned by a previous pull, or 0')
  const since = Number(sinceS)
  const limit = q.has('limit') ? int(Number(q.get('limit')), 'limit', 1, LIMITS.pullMax) : LIMITS.pullDefault
  const { env } = ctx

  // One batch is one consistent snapshot. Each table gives its first limit+1 rows after the cursor; the
  // smallest `limit` seqs across all of them are the page.
  const results = await env.DB.batch<Row | { sync_seq: number }>([
    env.DB.prepare('SELECT sync_seq FROM accounts WHERE id = ?').bind(account.id),
    ...SECTIONS.map(s => env.DB.prepare(`SELECT * FROM ${TABLE[s]} WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`).bind(account.id, since, limit + 1)),
  ])
  const head = (results[0].results[0] as { sync_seq: number }).sync_seq
  if (since > head) throw new HttpError(409, 'cursor_ahead', 'This cursor is from a newer state than the server has; pull again from since=0')
  const all: Array<{ s: Section; r: Row }> = []
  SECTIONS.forEach((s, i) => { for (const r of results[i + 1].results as Row[]) all.push({ s, r }) })
  all.sort((a, b) => a.r.seq - b.r.seq)
  const page = all.slice(0, limit)
  const more = all.length > limit
  const out = Object.fromEntries(SECTIONS.map(s => [s, [] as unknown[]])) as Record<Section, unknown[]>
  for (const { s, r } of page) out[s].push(OUT[s](r))
  // The cursor only moves when rows come back (a push that changed nothing leaves gaps in seq, not rows).
  const cursor = page.length ? page[page.length - 1].r.seq : since
  return json({ cursor: String(cursor), more, serverTime: ctx.now, ...out })
}
