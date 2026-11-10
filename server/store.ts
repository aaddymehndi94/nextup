import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { DismissReason, MediaType, Profile, Rating, TitleState, WatchProgress } from '../shared/types.ts'
import { transaction, uuidv7 } from './db.ts'
import { ACCIDENTAL_SEC, isCompleted } from './reco/signals.ts'
import type { Impression, ItemRef, ProgressRow, TasteSnapshot } from './reco/types.ts'

export type { Impression, ItemRef, ProgressRow, TasteSnapshot }

export interface ProgressInput extends ItemRef {
  /** Movie id or `tt…:season:episode`. Never a torrent hash or file name. */
  streamId: string
  position: number
  duration: number
}

// Profiles and per-profile taste state. Every write appends an immutable event and updates the
// materialised row it affects (with `updated_at`, tombstones instead of deletes) in one transaction,
// so a sync layer can wrap this interface without touching callers. See docs/adr/0003.

export interface TasteEvent {
  id: string
  profileId: string
  itemId: string
  itemType: MediaType
  kind: string
  value: number | null
  context: Record<string, unknown> | null
  at: number
}

export interface TasteStore {
  listProfiles (): Profile[]
  getProfile (id: string): Profile | null
  /** The oldest profile, creating "Me" when there is none. */
  defaultProfile (): Profile
  createProfile (input: { name: string; avatar?: string }): Profile
  updateProfile (id: string, patch: { name?: string; avatar?: string | null }): Profile | null
  deleteProfile (id: string): boolean

  setRating (profileId: string, item: ItemRef, value: Rating, source?: string): void
  setInList (profileId: string, item: ItemRef, inList: boolean): void
  recordProgress (profileId: string, input: ProgressInput): WatchProgress
  /** 'hide' removes from Continue watching only; 'forget' also drops it from taste and history. */
  clearProgress (profileId: string, item: ItemRef, mode: 'hide' | 'forget'): void
  dismiss (profileId: string, item: ItemRef, reason: DismissReason | null): void
  setFeaturePref (profileId: string, feature: string, value: 1 | -1 | 0): void

  titleState (profileId: string, item: ItemRef): TitleState
  snapshot (profileId: string): TasteSnapshot
  events (profileId: string, sinceMs?: number): TasteEvent[]

  /** LOCAL: titles shown on the home screen. Counted at most once per `windowMs` per title. */
  recordImpressions (profileId: string, itemIds: string[], windowMs?: number): void
  impressions (profileId: string): Map<string, Impression>

  onChange (fn: (profileId: string) => void): void
}

export const progressOf = (r: ProgressRow): WatchProgress => ({
  streamId: r.streamId,
  season: r.season,
  episode: r.episode,
  position: r.position,
  duration: r.duration,
  fraction: r.duration > 0 ? Math.min(1, r.position / r.duration) : 0,
  completed: r.completedAt !== undefined,
  updatedAt: r.updatedAt,
})

type Row = Record<string, string | number | null>
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v))

export class SqliteTasteStore implements TasteStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly statements = new Map<string, StatementSync>()
  private readonly listeners: Array<(profileId: string) => void> = []

  constructor (db: DatabaseSync, opts: { now?: () => number } = {}) {
    this.db = db
    this.now = opts.now ?? Date.now
  }

  private q (sql: string): StatementSync {
    let s = this.statements.get(sql)
    if (!s) { s = this.db.prepare(sql); this.statements.set(sql, s) }
    return s
  }

  private changed (profileId: string): void {
    for (const fn of this.listeners) fn(profileId)
  }

  onChange (fn: (profileId: string) => void): void { this.listeners.push(fn) }

  private event (profileId: string, item: ItemRef, kind: string, value: number | null, context: Record<string, unknown> | null, at: number): void {
    this.q('INSERT INTO events (id, profile_id, item_id, item_type, kind, value, context, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv7(at), profileId, item.id, item.type, kind, value, context ? JSON.stringify(context) : null, at)
  }

  // ---- Profiles ----------------------------------------------------------------

  private profileOf (r: Row): Profile {
    return { id: String(r.id), name: String(r.name), avatar: r.avatar === null ? undefined : String(r.avatar), createdAt: Number(r.created_at) }
  }

  listProfiles (): Profile[] {
    return (this.q('SELECT * FROM profiles WHERE deleted_at IS NULL ORDER BY created_at, id').all() as Row[]).map(r => this.profileOf(r))
  }

  getProfile (id: string): Profile | null {
    const r = this.q('SELECT * FROM profiles WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined
    return r ? this.profileOf(r) : null
  }

  defaultProfile (): Profile {
    return this.listProfiles()[0] ?? this.createProfile({ name: 'Me' })
  }

  createProfile (input: { name: string; avatar?: string }): Profile {
    const at = this.now()
    const id = uuidv7(at)
    this.q('INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)')
      .run(id, input.name, input.avatar ?? null, at, at)
    return this.getProfile(id)!
  }

  updateProfile (id: string, patch: { name?: string; avatar?: string | null }): Profile | null {
    const p = this.getProfile(id)
    if (!p) return null
    const avatar = patch.avatar === undefined ? p.avatar ?? null : patch.avatar
    this.q('UPDATE profiles SET name = ?, avatar = ?, updated_at = ? WHERE id = ?').run(patch.name ?? p.name, avatar, this.now(), id)
    return this.getProfile(id)
  }

  deleteProfile (id: string): boolean {
    const at = this.now()
    const r = this.q('UPDATE profiles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(at, at, id)
    if (r.changes) this.changed(id)
    return Number(r.changes) > 0
  }

  // ---- Taste writes --------------------------------------------------------------

  setRating (profileId: string, item: ItemRef, value: Rating, source?: string): void {
    const at = this.now()
    transaction(this.db, () => {
      this.q(`INSERT INTO ratings (profile_id, item_id, item_type, value, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (profile_id, item_id) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`)
        .run(profileId, item.id, item.type, value, source ?? null, at)
      this.event(profileId, item, 'rating', value, source ? { source } : null, at)
      // A rating is a judgement: "not interested" no longer applies, and a disliked title leaves My List.
      if (value !== 0) this.q('UPDATE dismissals SET reason = NULL, updated_at = ? WHERE profile_id = ? AND item_id = ? AND reason = \'not_interested\'').run(at, profileId, item.id)
      if (value === -1) this.q('UPDATE my_list SET in_list = 0, updated_at = ? WHERE profile_id = ? AND item_id = ? AND in_list = 1').run(at, profileId, item.id)
    })
    this.changed(profileId)
  }

  setInList (profileId: string, item: ItemRef, inList: boolean): void {
    const at = this.now()
    transaction(this.db, () => {
      this.q(`INSERT INTO my_list (profile_id, item_id, item_type, in_list, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (profile_id, item_id) DO UPDATE SET
                added_at = CASE WHEN excluded.in_list = 1 AND my_list.in_list = 0 THEN excluded.added_at ELSE my_list.added_at END,
                in_list = excluded.in_list, updated_at = excluded.updated_at`)
        .run(profileId, item.id, item.type, inList ? 1 : 0, at, at)
      this.event(profileId, item, 'list', inList ? 1 : 0, null, at)
    })
    this.changed(profileId)
  }

  recordProgress (profileId: string, input: ProgressInput): WatchProgress {
    const at = this.now()
    const position = Math.max(0, Math.min(input.position, input.duration))
    const [, s, e] = input.streamId.split(':')
    const season = s !== undefined ? Number(s) : null
    const episode = e !== undefined ? Number(e) : null
    let completedNow = false
    let continuesNow = false
    let row: ProgressRow
    transaction(this.db, () => {
      const prev = this.q('SELECT * FROM progress WHERE profile_id = ? AND stream_id = ?').get(profileId, input.streamId) as Row | undefined
      const fresh = !prev || Number(prev.forgotten) === 1
      let watched = fresh ? 0 : Number(prev.watched_sec)
      let maxPos = fresh ? position : Math.max(Number(prev.max_position), position)
      if (!fresh) {
        // Only forward movement no faster than the wall clock counts as watching; a seek adds nothing.
        const wallSec = (at - Number(prev.updated_at)) / 1000
        const delta = position - Number(prev.position)
        if (delta > 0 && wallSec > 0 && wallSec <= 90) watched += Math.min(delta, wallSec + 2)
      }
      const wasCompleted = !fresh && prev.completed_at !== null
      const completed = wasCompleted || isCompleted(position, input.duration, watched)
      completedNow = completed && !wasCompleted
      // Continue watching lists a title once it has two minutes of real playback and 1% of it, which is
      // usually a later ping than the first; Home needs to hear about that one too.
      const continues = (w: number, pos: number, dur: number) => w >= ACCIDENTAL_SEC && dur > 0 && pos / dur >= 0.01
      continuesNow = continues(watched, position, input.duration) &&
        (fresh || Number(prev.hidden) === 1 || !continues(Number(prev.watched_sec), Number(prev.position), Number(prev.duration)))
      const completedAt = wasCompleted ? Number(prev.completed_at) : completed ? at : null
      const startedAt = fresh ? at : Number(prev.started_at)
      if (fresh && prev) maxPos = position
      this.q(`INSERT INTO progress (profile_id, stream_id, item_id, item_type, season, episode, position, duration, max_position,
                                    watched_sec, completed_at, started_at, updated_at, hidden, forgotten)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
              ON CONFLICT (profile_id, stream_id) DO UPDATE SET
                position = excluded.position, duration = excluded.duration, max_position = excluded.max_position,
                watched_sec = excluded.watched_sec, completed_at = excluded.completed_at, started_at = excluded.started_at,
                updated_at = excluded.updated_at, hidden = 0, forgotten = 0`)
        .run(profileId, input.streamId, input.id, input.type, season, episode, position, input.duration, maxPos, watched, completedAt, startedAt, at)

      // The log gets milestones, not every 10 s ping: a play (new or resumed after 30 min), quartiles, completion.
      const ctx = { streamId: input.streamId, position: Math.round(position), duration: Math.round(input.duration), watchedSec: Math.round(watched) }
      const frac = input.duration > 0 ? position / input.duration : 0
      const prevFrac = !fresh && Number(prev.duration) > 0 ? Number(prev.position) / Number(prev.duration) : 0
      if (fresh || at - Number(prev.updated_at) > 30 * 60_000) this.event(profileId, input, 'play', frac, ctx, at)
      const quartile = Math.floor(frac * 4)
      if (!fresh && quartile > Math.floor(prevFrac * 4) && quartile >= 1 && quartile <= 3) this.event(profileId, input, 'progress', quartile / 4, ctx, at)
      if (completedNow) this.event(profileId, input, 'complete', 1, ctx, at)
      row = this.progressRow(this.q('SELECT * FROM progress WHERE profile_id = ? AND stream_id = ?').get(profileId, input.streamId) as Row)
    })
    // Pings are frequent; only state changes that matter to recommendations notify.
    if (completedNow || continuesNow || row!.startedAt === at) this.changed(profileId)
    return progressOf(row!)
  }

  clearProgress (profileId: string, item: ItemRef, mode: 'hide' | 'forget'): void {
    const at = this.now()
    transaction(this.db, () => {
      const col = mode === 'hide' ? 'hidden' : 'forgotten'
      this.q(`UPDATE progress SET ${col} = 1, updated_at = ? WHERE profile_id = ? AND item_id = ?`).run(at, profileId, item.id)
      this.event(profileId, item, mode, null, null, at)
    })
    this.changed(profileId)
  }

  dismiss (profileId: string, item: ItemRef, reason: DismissReason | null): void {
    const at = this.now()
    transaction(this.db, () => {
      this.q(`INSERT INTO dismissals (profile_id, item_id, item_type, reason, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (profile_id, item_id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`)
        .run(profileId, item.id, item.type, reason, at)
      this.event(profileId, item, 'dismiss', reason ? 1 : 0, reason ? { reason } : null, at)
      if (reason === 'not_interested') this.q('UPDATE my_list SET in_list = 0, updated_at = ? WHERE profile_id = ? AND item_id = ? AND in_list = 1').run(at, profileId, item.id)
    })
    this.changed(profileId)
  }

  setFeaturePref (profileId: string, feature: string, value: 1 | -1 | 0): void {
    const at = this.now()
    transaction(this.db, () => {
      this.q(`INSERT INTO feature_prefs (profile_id, feature, value, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (profile_id, feature) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(profileId, feature, value, at)
      // Events are keyed by item; a feature preference is logged against a placeholder item.
      this.q('INSERT INTO events (id, profile_id, item_id, item_type, kind, value, context, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uuidv7(at), profileId, '-', 'movie', 'pref', value, JSON.stringify({ feature }), at)
    })
    this.changed(profileId)
  }

  // ---- Reads -------------------------------------------------------------------------

  private progressRow (r: Row): ProgressRow {
    return {
      id: String(r.item_id),
      type: r.item_type as MediaType,
      streamId: String(r.stream_id),
      season: num(r.season),
      episode: num(r.episode),
      position: Number(r.position),
      duration: Number(r.duration),
      maxPosition: Number(r.max_position),
      watchedSec: Number(r.watched_sec),
      completedAt: num(r.completed_at),
      startedAt: Number(r.started_at),
      updatedAt: Number(r.updated_at),
      hidden: Number(r.hidden) === 1,
    }
  }

  titleState (profileId: string, item: ItemRef): TitleState {
    const rating = this.q('SELECT value FROM ratings WHERE profile_id = ? AND item_id = ?').get(profileId, item.id) as Row | undefined
    const list = this.q('SELECT in_list FROM my_list WHERE profile_id = ? AND item_id = ?').get(profileId, item.id) as Row | undefined
    const dis = this.q('SELECT reason FROM dismissals WHERE profile_id = ? AND item_id = ?').get(profileId, item.id) as Row | undefined
    const rows = (this.q('SELECT * FROM progress WHERE profile_id = ? AND item_id = ? AND forgotten = 0').all(profileId, item.id) as Row[]).map(r => this.progressRow(r))
    const latest = rows.reduce<ProgressRow | null>((a, r) => (!a || r.updatedAt > a.updatedAt ? r : a), null)
    const state: TitleState = {
      rating: (rating ? Number(rating.value) : 0) as Rating,
      inList: Number(list?.in_list ?? 0) === 1,
      progress: latest ? progressOf(latest) : null,
      dismissed: (dis?.reason ?? null) as DismissReason | null,
    }
    if (item.type === 'series') {
      state.episodes = rows
        .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))
        .map(progressOf)
    }
    return state
  }

  snapshot (profileId: string): TasteSnapshot {
    const ratings = (this.q('SELECT * FROM ratings WHERE profile_id = ? AND value != 0').all(profileId) as Row[])
      .map(r => ({ id: String(r.item_id), type: r.item_type as MediaType, value: Number(r.value) as 1 | -1, source: r.source === null ? undefined : String(r.source), at: Number(r.updated_at) }))
    const list = (this.q('SELECT * FROM my_list WHERE profile_id = ? AND in_list = 1 ORDER BY added_at DESC').all(profileId) as Row[])
      .map(r => ({ id: String(r.item_id), type: r.item_type as MediaType, addedAt: Number(r.added_at), at: Number(r.updated_at) }))
    const progress = (this.q('SELECT * FROM progress WHERE profile_id = ? AND forgotten = 0').all(profileId) as Row[]).map(r => this.progressRow(r))
    const dismissals = (this.q('SELECT * FROM dismissals WHERE profile_id = ? AND reason IS NOT NULL').all(profileId) as Row[])
      .map(r => ({ id: String(r.item_id), type: r.item_type as MediaType, reason: r.reason as DismissReason, at: Number(r.updated_at) }))
    const prefs = new Map<string, 1 | -1>()
    for (const r of this.q('SELECT feature, value FROM feature_prefs WHERE profile_id = ? AND value != 0').all(profileId) as Row[]) {
      prefs.set(String(r.feature), Number(r.value) as 1 | -1)
    }
    return { ratings, list, progress, dismissals, prefs }
  }

  events (profileId: string, sinceMs = 0): TasteEvent[] {
    return (this.q('SELECT * FROM events WHERE profile_id = ? AND at >= ? ORDER BY at, id').all(profileId, sinceMs) as Row[]).map(r => ({
      id: String(r.id),
      profileId: String(r.profile_id),
      itemId: String(r.item_id),
      itemType: r.item_type as MediaType,
      kind: String(r.kind),
      value: r.value === null ? null : Number(r.value),
      context: r.context === null ? null : JSON.parse(String(r.context)) as Record<string, unknown>,
      at: Number(r.at),
    }))
  }

  recordImpressions (profileId: string, itemIds: string[], windowMs = 60 * 60_000): void {
    if (!itemIds.length) return
    const at = this.now()
    const stmt = this.q(`INSERT INTO impressions (profile_id, item_id, count, first_at, last_at) VALUES (?, ?, 1, ?, ?)
                         ON CONFLICT (profile_id, item_id) DO UPDATE SET
                           count = CASE WHEN excluded.last_at - impressions.last_at >= ? THEN impressions.count + 1 ELSE impressions.count END,
                           last_at = CASE WHEN excluded.last_at - impressions.last_at >= ? THEN excluded.last_at ELSE impressions.last_at END`)
    transaction(this.db, () => {
      for (const id of new Set(itemIds)) stmt.run(profileId, id, at, at, windowMs, windowMs)
    })
  }

  impressions (profileId: string): Map<string, Impression> {
    const out = new Map<string, Impression>()
    for (const r of this.q('SELECT * FROM impressions WHERE profile_id = ?').all(profileId) as Row[]) {
      out.set(String(r.item_id), { count: Number(r.count), firstAt: Number(r.first_at), lastAt: Number(r.last_at) })
    }
    return out
  }
}
