import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The local database: profiles, taste state and the metadata cache, in <dataDir>/nexttupp.db.
//
// Sync shape (see docs/adr/0003): everything that will sync to a future cloud service (profiles, events,
// ratings, my_list, progress, dismissals, feature_prefs) has a globally unique key that is not an
// autoincrement (UUIDv7 or profile id + IMDb/stream id), carries `updated_at` for last-write-wins merging,
// and is never hard-deleted (removal = tombstone row). `events` is immutable and append-only. Tables
// marked LOCAL never sync. No torrent info hash, file name or source name goes in any of them.

/** Each entry upgrades the schema by one version (`PRAGMA user_version`). Never edit a shipped entry. */
const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE profiles (
    id          TEXT PRIMARY KEY,           -- UUIDv7
    account_id  TEXT,                       -- NULL until real accounts exist
    name        TEXT NOT NULL,
    avatar      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER                     -- tombstone
  ) WITHOUT ROWID;
  CREATE INDEX profiles_account ON profiles (account_id);

  -- Every taste signal, immutable and append-only. Materialised tables below are derived views of it.
  CREATE TABLE events (
    id          TEXT PRIMARY KEY,           -- UUIDv7, so pushing to a server is idempotent
    profile_id  TEXT NOT NULL,
    item_id     TEXT NOT NULL,              -- IMDb id of the title (the series for an episode)
    item_type   TEXT NOT NULL CHECK (item_type IN ('movie', 'series')),
    kind        TEXT NOT NULL,              -- rating | list | play | progress | complete | dismiss | forget | hide | pref
    value       REAL,
    context     TEXT,                       -- JSON: streamId, position, duration, source, reason, feature …
    at          INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX events_profile_at ON events (profile_id, at);

  CREATE TABLE ratings (
    profile_id  TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    item_type   TEXT NOT NULL,
    value       INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),   -- 0 = cleared (tombstone)
    source      TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
  ) WITHOUT ROWID;

  CREATE TABLE my_list (
    profile_id  TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    item_type   TEXT NOT NULL,
    in_list     INTEGER NOT NULL CHECK (in_list IN (0, 1)),     -- 0 = removed (tombstone)
    added_at    INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
  ) WITHOUT ROWID;

  -- One row per movie or episode watched. watched_sec counts real playback only (seeks don't add).
  CREATE TABLE progress (
    profile_id    TEXT NOT NULL,
    stream_id     TEXT NOT NULL,            -- movie id or tt…:season:episode
    item_id       TEXT NOT NULL,
    item_type     TEXT NOT NULL,
    season        INTEGER,
    episode       INTEGER,
    position      REAL NOT NULL,
    duration      REAL NOT NULL,
    max_position  REAL NOT NULL,
    watched_sec   REAL NOT NULL DEFAULT 0,
    completed_at  INTEGER,
    started_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    hidden        INTEGER NOT NULL DEFAULT 0,   -- removed from Continue watching, still counts as taste
    forgotten     INTEGER NOT NULL DEFAULT 0,   -- "that wasn't me": tombstone, ignored everywhere
    PRIMARY KEY (profile_id, stream_id)
  ) WITHOUT ROWID;
  CREATE INDEX progress_item ON progress (profile_id, item_id);

  CREATE TABLE dismissals (
    profile_id  TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    item_type   TEXT NOT NULL,
    reason      TEXT CHECK (reason IN ('not_interested', 'seen')),   -- NULL = undone (tombstone)
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
  ) WITHOUT ROWID;

  -- Explicit tuning: "more of this director", "never show horror".
  CREATE TABLE feature_prefs (
    profile_id  TEXT NOT NULL,
    feature     TEXT NOT NULL,
    value       INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),   -- 0 = cleared (tombstone)
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, feature)
  ) WITHOUT ROWID;

  -- LOCAL: how often a title was shown on the home screen without being acted on (freshness).
  CREATE TABLE impressions (
    profile_id  TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    count       INTEGER NOT NULL,
    first_at    INTEGER NOT NULL,
    last_at     INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
  ) WITHOUT ROWID;

  -- LOCAL: Cinemeta metadata cache. List columns are JSON arrays.
  CREATE TABLE items (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    name         TEXT NOT NULL,
    year         INTEGER,
    year_end     INTEGER,
    released     TEXT,
    poster       TEXT,
    background   TEXT,
    logo         TEXT,
    description  TEXT,
    genres       TEXT NOT NULL DEFAULT '[]',
    actors       TEXT NOT NULL DEFAULT '[]',
    directors    TEXT NOT NULL DEFAULT '[]',
    writers      TEXT NOT NULL DEFAULT '[]',
    countries    TEXT NOT NULL DEFAULT '[]',
    runtime      INTEGER,
    imdb_rating  REAL,
    popularity   REAL,                      -- TMDB popularity as relayed by Cinemeta
    moviedb_id   INTEGER,
    episodes     TEXT,                      -- series, from the full meta: JSON [[season, episode], …]
    detailed     INTEGER NOT NULL DEFAULT 0,-- 1 = from /meta (has episodes), 0 = from a catalog page
    fetched_at   INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- LOCAL: Cinemeta catalog/search pages already fetched, so restarts don't re-crawl.
  CREATE TABLE catalog_pages (
    key         TEXT PRIMARY KEY,
    ids         TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- Reserved for the sync layer (cursor, device id). Empty for now.
  CREATE TABLE sync_state (
    key    TEXT PRIMARY KEY,
    value  TEXT
  ) WITHOUT ROWID;
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function openDb (file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;')
  migrate(db)
  return db
}

export function migrate (db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (current > MIGRATIONS.length) throw new Error(`nexttupp.db is schema v${current}, newer than this build (v${MIGRATIONS.length})`)
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

export function transaction<T> (db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Time-ordered, globally unique id (RFC 9562 UUIDv7). */
export function uuidv7 (now = Date.now()): string {
  const b = randomBytes(16)
  let t = now
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256) }
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
