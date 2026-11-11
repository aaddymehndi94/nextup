import type { DatabaseSync } from 'node:sqlite'
import {
  type Batch, CONTEXT_KEYS, type DismissalW, type EventW, type Kind, type ListW, LIMITS, type MediaType, type PrefW, type ProfileW,
  type ProgressW, RATING_SOURCE, type RatingW, SECTIONS, type Section, VALIDATORS,
} from '../../cloud/src/wire.ts'
import { transaction } from '../db.ts'

// The database side of sync: local rows ↔ the cloud's wire format (cloud/README.md), what to push (from
// the trigger-filled `sync_outbox`), how pulled rows merge in, and how this device's profiles join an
// account at sign-in. No network here; service.ts drives it. Only the synced tables are touched, and the
// wire format has no field for a title, source, info hash or file name.

type Row = Record<string, string | number | null>

/** Local table behind each wire section, and the outbox's name for it. */
export const TABLE: Record<Section, string> = {
  profiles: 'profiles', events: 'events', ratings: 'ratings', list: 'my_list', progress: 'progress', dismissals: 'dismissals', prefs: 'feature_prefs',
}
const SECTION_OF = Object.fromEntries(SECTIONS.map(s => [TABLE[s], s])) as Record<string, Section>

/** Each synced table's key after profile_id (events and profiles are keyed by id alone). */
const KEY2: Record<string, string> = { ratings: 'item_id', my_list: 'item_id', progress: 'stream_id', dismissals: 'item_id', feature_prefs: 'feature' }

export const emptyBatch = (): Batch => ({ profiles: [], events: [], ratings: [], list: [], progress: [], dismissals: [], prefs: [] })

// ---- Local row → wire --------------------------------------------------------------------

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const flag = (v: unknown) => (Number(v) === 1 ? 1 : 0) as 0 | 1
const source = (v: unknown) => (typeof v === 'string' && RATING_SOURCE.test(v) ? v : null)

export function wireRow (section: Section, r: Row): Batch[Section][number] {
  switch (section) {
    case 'profiles': return {
      id: String(r.id), name: String(r.name), avatar: r.avatar === null ? null : String(r.avatar),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), deletedAt: n(r.deleted_at),
    } satisfies ProfileW
    case 'events': {
      const kind = String(r.kind) as Kind
      const pref = kind === 'pref'
      let context: Record<string, unknown> | null = null
      if (r.context !== null) {
        const raw = JSON.parse(String(r.context)) as Record<string, unknown>
        // Only the keys the cloud allows for this kind; a free-text rating source that isn't a plain word is dropped.
        context = Object.fromEntries(Object.entries(raw).filter(([k, v]) => CONTEXT_KEYS[kind]?.includes(k) && (k !== 'source' || source(v) !== null)))
        if (!Object.keys(context).length) context = null
      }
      return {
        id: String(r.id), profileId: String(r.profile_id), kind,
        itemId: pref ? null : String(r.item_id), itemType: pref ? null : r.item_type as MediaType,
        value: kind === 'forget' || kind === 'hide' ? null : n(r.value), context, at: Number(r.at),
      } satisfies EventW
    }
    case 'ratings': return {
      profileId: String(r.profile_id), itemId: String(r.item_id), itemType: r.item_type as MediaType,
      value: Number(r.value) as RatingW['value'], source: source(r.source), updatedAt: Number(r.updated_at),
    } satisfies RatingW
    case 'list': return {
      profileId: String(r.profile_id), itemId: String(r.item_id), itemType: r.item_type as MediaType,
      inList: flag(r.in_list), addedAt: Number(r.added_at), updatedAt: Number(r.updated_at),
    } satisfies ListW
    case 'progress': return {
      profileId: String(r.profile_id), streamId: String(r.stream_id), itemId: String(r.item_id), itemType: r.item_type as MediaType,
      season: n(r.season), episode: n(r.episode), position: Number(r.position), duration: Number(r.duration),
      maxPosition: Number(r.max_position), watchedSec: Number(r.watched_sec), completedAt: n(r.completed_at),
      startedAt: Number(r.started_at), updatedAt: Number(r.updated_at), hidden: flag(r.hidden), forgotten: flag(r.forgotten),
    } satisfies ProgressW
    case 'dismissals': return {
      profileId: String(r.profile_id), itemId: String(r.item_id), itemType: r.item_type as MediaType,
      reason: r.reason as DismissalW['reason'], updatedAt: Number(r.updated_at),
    } satisfies DismissalW
    case 'prefs': return {
      profileId: String(r.profile_id), feature: String(r.feature), value: Number(r.value) as PrefW['value'], updatedAt: Number(r.updated_at),
    } satisfies PrefW
  }
}

// ---- Muting ------------------------------------------------------------------------------

/** Runs `fn` in a transaction with the outbox triggers off: what it writes isn't queued for pushing. */
export function muted<T> (db: DatabaseSync, fn: () => T): T {
  return transaction(db, () => {
    db.prepare('INSERT INTO sync_mute (x) VALUES (1)').run()
    try { return fn() } finally { db.prepare('DELETE FROM sync_mute').run() }
  })
}

// ---- Push --------------------------------------------------------------------------------

export interface Outgoing {
  batch: Batch
  /** Outbox ids this batch carries; cleared by ackPush once the cloud has them. */
  ids: number[]
  /** For each row in the batch, the outbox id it came from (null for a profile added as a reference). */
  origin: Record<Section, Array<number | null>>
}

type ProfileState = 'mine' | 'deleted' | 'other' | 'drop'

/**
 * The next push for `accountId`, or null when there's nothing to send. Every profile a row refers to rides
 * along, so the cloud never sees a row for a profile it doesn't know. Outbox entries that can never sync
 * (a deleted profile that was never on an account, a row the cloud would refuse) are dropped here; entries
 * for profiles that belong to another account stay for when that account signs in again.
 */
export function collectPush (db: DatabaseSync, accountId: string, now: number, opts: { maxRows?: number; maxBytes?: number; log?: (msg: string) => void } = {}): Outgoing | null {
  const maxRows = opts.maxRows ?? LIMITS.pushItems
  const maxBytes = opts.maxBytes ?? 200 * 1024
  const log = opts.log ?? (() => {})
  const batch = emptyBatch()
  const origin = Object.fromEntries(SECTIONS.map(s => [s, []])) as unknown as Outgoing['origin']
  const ids: number[] = []
  const drop: number[] = []
  const included = new Set<string>()
  const states = new Map<string, ProfileState>()
  let rows = 0
  let bytes = 64

  const profileRow = (id: string) => db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Row | undefined
  const validate = (s: Section, r: unknown): boolean => {
    try { VALIDATORS[s](r, s, now); return true } catch (err) { log(`sync: not syncing a ${s} row: ${(err as Error).message}`); return false }
  }

  function stateOf (pid: string): ProfileState {
    let st = states.get(pid)
    if (st) return st
    const p = profileRow(pid)
    if (!p) st = 'drop'
    else if (p.account_id !== null && p.account_id !== accountId) st = 'other'
    else if (p.deleted_at !== null) st = p.account_id === null ? 'drop' : 'deleted'
    else {
      if (p.account_id === null) {
        // A profile made on this device while signed in: it joins the account now.
        muted(db, () => db.prepare('UPDATE profiles SET account_id = ? WHERE id = ?').run(accountId, pid))
        p.account_id = accountId
      }
      st = validate('profiles', wireRow('profiles', p)) ? 'mine' : 'drop'
    }
    states.set(pid, st)
    return st
  }

  function add (s: Section, r: Batch[Section][number], from: number | null): boolean {
    const size = JSON.stringify(r).length + 1
    if (rows + 1 > maxRows || bytes + size > maxBytes) return false
    ;(batch[s] as unknown[]).push(r)
    origin[s].push(from)
    rows++
    bytes += size
    return true
  }

  function includeProfile (pid: string, from: number | null): boolean {
    if (included.has(pid)) return true
    if (!add('profiles', wireRow('profiles', profileRow(pid)!), from)) return false
    included.add(pid)
    return true
  }

  let after = 0
  scan: for (;;) {
    const entries = db.prepare('SELECT id, tbl, k1, k2 FROM sync_outbox WHERE id > ? ORDER BY id LIMIT 500').all(after) as Array<{ id: number; tbl: string; k1: string; k2: string }>
    if (!entries.length) break
    for (const e of entries) {
      after = e.id
      const s = SECTION_OF[e.tbl]
      if (!s) { drop.push(e.id); continue }
      if (s === 'profiles') {
        const st = stateOf(e.k1)
        if (st === 'other') continue
        if (st === 'drop') { drop.push(e.id); continue }
        if (included.has(e.k1)) { ids.push(e.id); continue }
        if (rows + 1 > maxRows) break scan
        if (!includeProfile(e.k1, e.id)) break scan
        ids.push(e.id)
        continue
      }
      const r = (s === 'events'
        ? db.prepare('SELECT * FROM events WHERE id = ?').get(e.k1)
        : db.prepare(`SELECT * FROM ${e.tbl} WHERE profile_id = ? AND ${KEY2[e.tbl]} = ?`).get(e.k1, e.k2)) as Row | undefined
      if (!r) { drop.push(e.id); continue }
      const st = stateOf(String(r.profile_id))
      if (st === 'other') continue
      // Rows of a deleted profile stay home: its tombstone is all the cloud needs.
      if (st !== 'mine') { drop.push(e.id); continue }
      const w = wireRow(s, r)
      if (!validate(s, w)) { drop.push(e.id); continue }
      const needsProfile = !included.has(String(r.profile_id))
      if (rows + (needsProfile ? 2 : 1) > maxRows) break scan
      if (needsProfile && !includeProfile(String(r.profile_id), null)) break scan
      if (!add(s, w, e.id)) break scan
      ids.push(e.id)
    }
  }
  if (drop.length) db.prepare('DELETE FROM sync_outbox WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(drop))
  return ids.length ? { batch, ids, origin } : null
}

/** The cloud has these rows: clear their outbox entries (unless they were written again meanwhile). */
export function ackPush (db: DatabaseSync, ids: number[]): void {
  db.prepare('DELETE FROM sync_outbox WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids))
}

/** Sets one outbox entry aside for good (a row the cloud refused). */
export function dropOutbox (db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM sync_outbox WHERE id = ?').run(id)
}

/** Rows waiting to be pushed for this account (approximate: entries of other accounts' profiles count too). */
export function pendingCount (db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n)
}

// ---- Pull --------------------------------------------------------------------------------

// Pulled rows win when `updatedAt >= local` (the cloud breaks ties, and its merged progress rows can carry
// the same updatedAt as what this device sent). A profile's local deletion is kept once set. Events are
// inserted once by id.
const APPLY: Record<Section, string> = {
  profiles: `INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               name = CASE WHEN excluded.updated_at >= profiles.updated_at THEN excluded.name ELSE profiles.name END,
               avatar = CASE WHEN excluded.updated_at >= profiles.updated_at THEN excluded.avatar ELSE profiles.avatar END,
               created_at = MIN(profiles.created_at, excluded.created_at),
               updated_at = MAX(profiles.updated_at, excluded.updated_at),
               deleted_at = COALESCE(profiles.deleted_at, excluded.deleted_at),
               account_id = COALESCE(profiles.account_id, excluded.account_id)
             WHERE excluded.updated_at >= profiles.updated_at OR (excluded.deleted_at IS NOT NULL AND profiles.deleted_at IS NULL)
               OR profiles.account_id IS NULL`,
  events: `INSERT OR IGNORE INTO events (id, profile_id, item_id, item_type, kind, value, context, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ratings: `INSERT INTO ratings (profile_id, item_id, item_type, value, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (profile_id, item_id) DO UPDATE SET item_type = excluded.item_type, value = excluded.value, source = excluded.source, updated_at = excluded.updated_at
            WHERE excluded.updated_at >= ratings.updated_at`,
  list: `INSERT INTO my_list (profile_id, item_id, item_type, in_list, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, item_id) DO UPDATE SET item_type = excluded.item_type, in_list = excluded.in_list, added_at = excluded.added_at, updated_at = excluded.updated_at
         WHERE excluded.updated_at >= my_list.updated_at`,
  progress: `INSERT INTO progress (profile_id, stream_id, item_id, item_type, season, episode, position, duration, max_position, watched_sec,
                                   completed_at, started_at, updated_at, hidden, forgotten) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (profile_id, stream_id) DO UPDATE SET
               item_id = excluded.item_id, item_type = excluded.item_type, season = excluded.season, episode = excluded.episode,
               position = excluded.position, duration = excluded.duration, max_position = excluded.max_position, watched_sec = excluded.watched_sec,
               completed_at = excluded.completed_at, started_at = excluded.started_at, updated_at = excluded.updated_at,
               hidden = excluded.hidden, forgotten = excluded.forgotten
             WHERE excluded.updated_at >= progress.updated_at`,
  dismissals: `INSERT INTO dismissals (profile_id, item_id, item_type, reason, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (profile_id, item_id) DO UPDATE SET item_type = excluded.item_type, reason = excluded.reason, updated_at = excluded.updated_at
               WHERE excluded.updated_at >= dismissals.updated_at`,
  prefs: `INSERT INTO feature_prefs (profile_id, feature, value, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, feature) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          WHERE excluded.updated_at >= feature_prefs.updated_at`,
}

function applyArgs (s: Section, w: Batch[Section][number], accountId: string): Array<string | number | null> {
  switch (s) {
    case 'profiles': { const p = w as ProfileW; return [p.id, accountId, p.name, p.avatar, p.createdAt, p.updatedAt, p.deletedAt] }
    case 'events': {
      const e = w as EventW
      return [e.id, e.profileId, e.itemId ?? '-', e.itemType ?? 'movie', e.kind, e.value, e.context ? JSON.stringify(e.context) : null, e.at]
    }
    case 'ratings': { const r = w as RatingW; return [r.profileId, r.itemId, r.itemType, r.value, r.source, r.updatedAt] }
    case 'list': { const r = w as ListW; return [r.profileId, r.itemId, r.itemType, r.inList, r.addedAt, r.updatedAt] }
    case 'progress': {
      const r = w as ProgressW
      return [r.profileId, r.streamId, r.itemId, r.itemType, r.season, r.episode, r.position, r.duration, r.maxPosition, r.watchedSec,
        r.completedAt, r.startedAt, r.updatedAt, r.hidden, r.forgotten]
    }
    case 'dismissals': { const r = w as DismissalW; return [r.profileId, r.itemId, r.itemType, r.reason, r.updatedAt] }
    case 'prefs': { const r = w as PrefW; return [r.profileId, r.feature, r.value, r.updatedAt] }
  }
}

/** Merges a pulled page into the local tables, without queueing it for pushing. Returns the profiles that changed. */
export function applyPull (db: DatabaseSync, accountId: string, batch: Partial<Batch>): Set<string> {
  const changed = new Set<string>()
  muted(db, () => {
    for (const s of SECTIONS) {
      const stmt = db.prepare(APPLY[s])
      for (const w of (batch[s] ?? []) as Array<Batch[Section][number]>) {
        if (Number(stmt.run(...applyArgs(s, w, accountId)).changes) > 0) changed.add(s === 'profiles' ? (w as ProfileW).id : (w as { profileId: string }).profileId)
      }
    }
  })
  return changed
}

// ---- Sign-in: this device's profiles join the account -----------------------------------------

const sameName = (a: unknown, b: unknown) => String(a).trim().toLocaleLowerCase() === String(b).trim().toLocaleLowerCase()

/** Columns copied when a merged profile's row is newer than the account profile's (everything but the key). */
const MERGE_COLS: Record<string, string[]> = {
  ratings: ['item_type', 'value', 'source', 'updated_at'],
  my_list: ['item_type', 'in_list', 'added_at', 'updated_at'],
  progress: ['item_id', 'item_type', 'season', 'episode', 'position', 'duration', 'max_position', 'watched_sec', 'completed_at', 'started_at', 'updated_at', 'hidden', 'forgotten'],
  dismissals: ['item_type', 'reason', 'updated_at'],
  feature_prefs: ['value', 'updated_at'],
}

/** Moves everything of profile `from` onto `to`; where both have a row, the newer one wins. */
function mergeProfileRows (db: DatabaseSync, from: string, to: string): void {
  for (const [t, cols] of Object.entries(MERGE_COLS)) {
    const k = KEY2[t]
    db.prepare(`UPDATE ${t} AS dst SET ${cols.map(c => `${c} = src.${c}`).join(', ')}
                FROM ${t} AS src WHERE src.profile_id = ?1 AND dst.profile_id = ?2 AND dst.${k} = src.${k} AND src.updated_at > dst.updated_at`).run(from, to)
    db.prepare(`DELETE FROM ${t} WHERE profile_id = ?1 AND ${k} IN (SELECT ${k} FROM ${t} WHERE profile_id = ?2)`).run(from, to)
    db.prepare(`UPDATE ${t} SET profile_id = ?2 WHERE profile_id = ?1`).run(from, to)
  }
  // LOCAL impressions follow too; where both have one, the account profile's is kept.
  db.prepare('DELETE FROM impressions WHERE profile_id = ?1 AND item_id IN (SELECT item_id FROM impressions WHERE profile_id = ?2)').run(from, to)
  db.prepare('UPDATE impressions SET profile_id = ?2 WHERE profile_id = ?1').run(from, to)
  db.prepare('UPDATE events SET profile_id = ?2 WHERE profile_id = ?1').run(from, to)
}

/** Queues every synced row of a profile (rows written before the outbox existed aren't in it). */
function enqueueProfile (db: DatabaseSync, pid: string): void {
  db.prepare("INSERT OR IGNORE INTO sync_outbox (tbl, k1, k2) VALUES ('profiles', ?, '')").run(pid)
  db.prepare("INSERT OR IGNORE INTO sync_outbox (tbl, k1, k2) SELECT 'events', id, '' FROM events WHERE profile_id = ?").run(pid)
  for (const [t, k] of Object.entries(KEY2)) {
    db.prepare(`INSERT OR IGNORE INTO sync_outbox (tbl, k1, k2) SELECT '${t}', profile_id, ${k} FROM ${t} WHERE profile_id = ?`).run(pid)
  }
}

/** The name of the profile a new install makes for itself (SqliteTasteStore.defaultProfile). */
const STARTER_NAME = 'Me'

/** True when a profile has nothing that syncs: no likes, list, progress, dismissals, preferences or events. */
function isEmptyProfile (db: DatabaseSync, pid: string): boolean {
  const tables = [...Object.keys(KEY2), 'events']
  return tables.every(t => db.prepare(`SELECT 1 FROM ${t} WHERE profile_id = ? LIMIT 1`).get(pid) === undefined)
}

/**
 * Runs once per sign-in, after the account's data has been pulled. Each profile on this device that
 * isn't on any account yet joins this one: if the account already has a live profile with the same name
 * (the default "Me" on a second computer, say), the two become one, keeping the newer of any two rows
 * about the same title. The untouched "Me" a new install makes for itself becomes the account's first
 * profile instead, so signing in on a new computer doesn't add an empty "Me" to every device. Any other
 * profile is added as a new one. Profiles that belong to another account are left alone. Returns
 * { local id → account profile id } for the merged ones, so the app can switch to the profile it became.
 */
export function linkProfiles (db: DatabaseSync, accountId: string, now: number): Record<string, string> {
  const merged: Record<string, string> = {}
  transaction(db, () => {
    const remote = db.prepare('SELECT * FROM profiles WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(accountId) as Row[]
    const local = db.prepare('SELECT * FROM profiles WHERE account_id IS NULL AND deleted_at IS NULL ORDER BY created_at, id').all() as Row[]
    const taken = new Set<string>()
    for (const l of local) {
      const lid = String(l.id)
      const match = remote.find(r => !taken.has(String(r.id)) && sameName(r.name, l.name)) ??
        (remote.length && sameName(l.name, STARTER_NAME) && isEmptyProfile(db, lid) ? remote[0] : undefined)
      if (match) {
        const mid = String(match.id)
        taken.add(mid)
        mergeProfileRows(db, lid, mid)
        // The local twin is retired here only: it was never on an account, so it never syncs.
        db.prepare('UPDATE profiles SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, lid)
        merged[lid] = mid
      } else {
        db.prepare('UPDATE profiles SET account_id = ? WHERE id = ?').run(accountId, lid)
        enqueueProfile(db, lid)
      }
    }
  })
  return merged
}
