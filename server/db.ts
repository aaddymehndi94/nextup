import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// The local database: profiles, taste state and the metadata cache, in <dataDir>/nexttupp.db.
//
// Sync shape (see docs/adr/0003, 0004): everything that syncs to the cloud (profiles, events, ratings,
// my_list, progress, dismissals, feature_prefs, and since migration 5 music likes, listens and asked-for
// mixes) has a globally unique key that is not an autoincrement (UUIDv7 or profile id + IMDb/stream id),
// carries `updated_at` for last-write-wins merging, and is never hard-deleted (removal = tombstone row).
// `events` and `music_listens` are immutable and append-only. Tables marked LOCAL never sync. No torrent
// info hash, file name or source name goes in any of them.

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

  /* 2 */ `
  -- Sync outbox (server/sync/): the key of every synced row written on this device since it was last
  -- pushed. Triggers fill it, so every write path is covered. A row written again gets a new id, so a push
  -- that was in flight only clears the versions it actually sent. Filled whether or not anyone is signed
  -- in; a key appears once however often its row changes.
  CREATE TABLE sync_outbox (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl  TEXT NOT NULL,
    k1   TEXT NOT NULL,
    k2   TEXT NOT NULL DEFAULT '',
    UNIQUE (tbl, k1, k2)
  );
  -- While a pull is applied, one row here silences the triggers: rows from the server aren't pushed back.
  CREATE TABLE sync_mute (x INTEGER);
${outboxTriggers([
    ['profiles', 'NEW.id', "''"],
    ['events', 'NEW.id', "''"],
    ['ratings', 'NEW.profile_id', 'NEW.item_id'],
    ['my_list', 'NEW.profile_id', 'NEW.item_id'],
    ['progress', 'NEW.profile_id', 'NEW.stream_id'],
    ['dismissals', 'NEW.profile_id', 'NEW.item_id'],
    ['feature_prefs', 'NEW.profile_id', 'NEW.feature'],
  ])}
  `,
  // AI (server/ai). What a model answered, kept until the viewer asks again, and a log of requests for the
  // usage line in AI settings. Local only: neither table is synced.
  `
  CREATE TABLE ai_results (
    profile_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,              -- 'picks' | 'search'
    key         TEXT NOT NULL,              -- '' for picks; the normalised query for search
    model       TEXT NOT NULL,
    at          INTEGER NOT NULL,
    data        TEXT NOT NULL,              -- JSON: [{ id, type, why, seed }]
    PRIMARY KEY (profile_id, kind, key)
  ) WITHOUT ROWID;
  CREATE TABLE ai_usage (
    at            INTEGER NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost          REAL                      -- USD, when the model's price is known
  );
  CREATE INDEX ai_usage_at ON ai_usage (at);
  `,
  // Music (server/music, docs/adr/0010). Migration 5 syncs music_ratings, music_listens and the asked-for
  // music_mixes (with the songs and artists they name); music_files and the engine's mixes stay local.
  `
  -- Every song the app has shown, so listens, likes and mixes can name it without asking Deezer again.
  CREATE TABLE music_tracks (
    id          TEXT PRIMARY KEY,           -- t + 16 hex, from the normalised artist and title
    title       TEXT NOT NULL,
    credit      TEXT,
    artist_id   TEXT NOT NULL,
    artist      TEXT NOT NULL,
    picture     TEXT,                       -- the artist's picture
    album_id    TEXT,
    album       TEXT,
    cover       TEXT,
    duration    INTEGER NOT NULL,
    explicit    INTEGER NOT NULL DEFAULT 0,
    rank        REAL NOT NULL DEFAULT 0,
    seen_at     INTEGER NOT NULL
  ) WITHOUT ROWID;
  -- Artists by name, with where each catalog keeps them.
  CREATE TABLE music_artists (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    picture     TEXT,
    itunes_id   TEXT,
    deezer_id   TEXT,
    seen_at     INTEGER NOT NULL
  ) WITHOUT ROWID;
  -- One row per listen, written when it ends: how much was heard and how it ended.
  CREATE TABLE music_listens (
    id          TEXT PRIMARY KEY,           -- UUIDv7
    profile_id  TEXT NOT NULL,
    track_id    TEXT NOT NULL,
    artist_id   TEXT NOT NULL,
    played      REAL NOT NULL,              -- seconds heard
    outcome     TEXT NOT NULL,              -- 'complete' | 'partial' | 'skip'
    at          INTEGER NOT NULL
  );
  CREATE INDEX music_listens_profile ON music_listens (profile_id, at);
  -- Likes and dislikes of songs and artists. rating 0 rows are kept as "changed their mind".
  CREATE TABLE music_ratings (
    profile_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,              -- 'track' | 'artist'
    item_id     TEXT NOT NULL,
    rating      INTEGER NOT NULL,           -- 1 | -1 | 0
    name        TEXT,
    picture     TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, kind, item_id)
  ) WITHOUT ROWID;
  -- Mixes as they were made (by the engine or a model), so Music home opens instantly.
  CREATE TABLE music_mixes (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    subtitle    TEXT NOT NULL,
    tracks      TEXT NOT NULL,              -- JSON: [{ id, why }]
    model       TEXT,
    at          INTEGER NOT NULL
  );
  CREATE INDEX music_mixes_profile ON music_mixes (profile_id, at);
  -- Song and video files kept on this computer (data/music), least recently played removed first.
  CREATE TABLE music_files (
    track_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,              -- 'audio' | 'video'
    ref         TEXT,                       -- where it came from (a YouTube video id)
    bytes       INTEGER NOT NULL,
    duration    REAL,
    used_at     INTEGER NOT NULL,
    PRIMARY KEY (track_id, kind)
  ) WITHOUT ROWID;
  `,
  /* 5 */ `
  -- Music sync (server/sync/music.ts, docs/adr/0004 "Update: music"). Its own outbox, filled the same way as
  -- sync_outbox, so film sync never waits behind thousands of listens and a cloud that doesn't sync music yet
  -- leaves them queued without fuss. music_ratings is keyed k1 = profile, k2 = 'kind:item'; listens and mixes
  -- by id. Only AI and mood mixes queue: the engine's daily, artist, Discover and On repeat mixes are remade
  -- on each computer from the synced likes and listens. Songs and artists aren't queued: a push carries the
  -- ones its rows name.
  CREATE TABLE sync_music_outbox (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl  TEXT NOT NULL,
    k1   TEXT NOT NULL,
    k2   TEXT NOT NULL DEFAULT '',
    UNIQUE (tbl, k1, k2)
  );
${outboxTriggers([
    ['music_ratings', 'NEW.profile_id', "NEW.kind || ':' || NEW.item_id"],
    ['music_listens', 'NEW.id', "''"],
    ['music_mixes', 'NEW.id', "''", "NEW.kind IN ('ai', 'mood')"],
  ], 'sync_music_outbox')}
  -- Everything from before this migration uploads on the first sync after it: likes first, then mixes, then listens.
  INSERT INTO sync_music_outbox (tbl, k1, k2) SELECT 'music_ratings', profile_id, kind || ':' || item_id FROM music_ratings ORDER BY updated_at;
  INSERT INTO sync_music_outbox (tbl, k1) SELECT 'music_mixes', id FROM music_mixes WHERE kind IN ('ai', 'mood') ORDER BY at;
  INSERT INTO sync_music_outbox (tbl, k1) SELECT 'music_listens', id FROM music_listens ORDER BY at;
  `,
]

/**
 * AFTER INSERT/UPDATE triggers that (re)queue a row's key with a fresh id. Delete-then-insert rather than
 * INSERT OR REPLACE: inside a trigger, the outer statement's conflict policy (an upsert's is ABORT) wins.
 * An optional fourth entry limits which rows queue.
 */
function outboxTriggers (tables: Array<[string, string, string, string?]>, outbox = 'sync_outbox'): string {
  return tables.map(([t, k1, k2, only]) => ['INSERT', 'UPDATE'].map(op => `
  CREATE TRIGGER ${t}_outbox_${op.toLowerCase()} AFTER ${op} ON ${t} WHEN NOT EXISTS (SELECT 1 FROM sync_mute)${only ? ` AND ${only}` : ''}
  BEGIN
    DELETE FROM ${outbox} WHERE tbl = '${t}' AND k1 = ${k1} AND k2 = ${k2};
    INSERT INTO ${outbox} (tbl, k1, k2) VALUES ('${t}', ${k1}, ${k2});
  END;`).join('')).join('')
}

export const SCHEMA_VERSION = MIGRATIONS.length

export function openDb (file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;')
  migrate(db)
  return db
}

/** Upgrades to the latest schema (or to `target`, for tests of a migration itself). */
export function migrate (db: DatabaseSync, target = MIGRATIONS.length): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (current > MIGRATIONS.length) throw new Error(`nexttupp.db is schema v${current}, newer than this build (v${MIGRATIONS.length})`)
  for (let v = current; v < Math.min(target, MIGRATIONS.length); v++) {
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
