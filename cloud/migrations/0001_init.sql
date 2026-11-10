-- nexttupp cloud, schema v1. Applied with `wrangler d1 migrations apply nexttupp`.
-- Times are integer milliseconds since the Unix epoch. Secrets (session, invite and reset tokens) are
-- stored only as hex SHA-256; passwords only as PBKDF2 hashes.

-- ---- Accounts ----------------------------------------------------------------------------

CREATE TABLE accounts (
  id                   TEXT PRIMARY KEY,                       -- UUIDv4
  email                TEXT NOT NULL UNIQUE,                   -- lowercased
  display_name         TEXT,
  role                 TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  password_hash        TEXT NOT NULL,                          -- pbkdf2-sha256$<iterations>$<salt>$<hash>
  invited_by           TEXT REFERENCES accounts (id),          -- NULL for the bootstrap admin
  created_at           INTEGER NOT NULL,
  password_changed_at  INTEGER NOT NULL,
  disabled_at          INTEGER,
  last_seen_at         INTEGER,
  sync_seq             INTEGER NOT NULL DEFAULT 0              -- last sync cursor value handed out
) STRICT;
CREATE INDEX accounts_invited_by ON accounts (invited_by);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
) WITHOUT ROWID, STRICT;
CREATE INDEX sessions_account ON sessions (account_id, last_used_at);

-- Single-use sign-up links. created_by NULL = the bootstrap invite (role 'admin'), made from the CLI.
CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  used_by     TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  revoked_at  INTEGER,
  revoked_by  TEXT REFERENCES accounts (id) ON DELETE SET NULL
) STRICT;
CREATE INDEX invites_created_by ON invites (created_by, created_at);
CREATE INDEX invites_created_at ON invites (created_at);
CREATE INDEX invites_used_by ON invites (used_by);

-- Admin-issued, single-use password reset links.
CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
) WITHOUT ROWID, STRICT;
CREATE INDEX password_resets_account ON password_resets (account_id);

-- Failed sign-in counters. key = hex SHA-256 of 'e:<email>' or 'i:<ip>', so no emails or IPs are kept.
CREATE TABLE login_attempts (
  key           TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
) WITHOUT ROWID, STRICT;
CREATE INDEX login_attempts_updated ON login_attempts (updated_at);

-- ---- Synced taste data ----------------------------------------------------------------------
-- Mirrors the local store (server/db.ts). Every row is scoped by account_id (in the key, so one account's
-- rows can never collide with another's) and carries seq, the cursor value of its last change.
-- Only IMDb ids, episode ids and small enums: no titles, sources, torrent hashes or file names.

CREATE TABLE profiles (
  id          TEXT PRIMARY KEY,                                -- UUID from the client
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  avatar      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,                                         -- tombstone (sticky)
  seq         INTEGER NOT NULL
) STRICT;
CREATE INDEX profiles_account_seq ON profiles (account_id, seq);

-- Immutable, insert-once by id. context is stored as typed columns, never as a JSON blob.
CREATE TABLE events (
  account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id           TEXT NOT NULL,                                  -- UUID from the client
  profile_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('rating', 'list', 'play', 'progress', 'complete', 'dismiss', 'forget', 'hide', 'pref')),
  item_id      TEXT,                                           -- NULL only for kind 'pref'
  item_type    TEXT CHECK (item_type IN ('movie', 'series')),
  value        REAL,
  at           INTEGER NOT NULL,
  stream_id    TEXT,
  position     REAL,
  duration     REAL,
  watched_sec  REAL,
  source       TEXT,
  reason       TEXT CHECK (reason IN ('not_interested', 'seen')),
  feature      TEXT,
  seq          INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
) WITHOUT ROWID, STRICT;
CREATE INDEX events_account_seq ON events (account_id, seq);

CREATE TABLE ratings (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  item_type   TEXT NOT NULL CHECK (item_type IN ('movie', 'series')),
  value       INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),     -- 0 = cleared (tombstone)
  source      TEXT,
  updated_at  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, item_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX ratings_account_seq ON ratings (account_id, seq);

CREATE TABLE my_list (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  item_type   TEXT NOT NULL CHECK (item_type IN ('movie', 'series')),
  in_list     INTEGER NOT NULL CHECK (in_list IN (0, 1)),        -- 0 = removed (tombstone)
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, item_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX my_list_account_seq ON my_list (account_id, seq);

CREATE TABLE progress (
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  profile_id    TEXT NOT NULL,
  stream_id     TEXT NOT NULL,                                 -- movie id or tt…:season:episode
  item_id       TEXT NOT NULL,
  item_type     TEXT NOT NULL CHECK (item_type IN ('movie', 'series')),
  season        INTEGER,
  episode       INTEGER,
  position      REAL NOT NULL,
  duration      REAL NOT NULL,
  max_position  REAL NOT NULL,
  watched_sec   REAL NOT NULL,
  completed_at  INTEGER,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  hidden        INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  forgotten     INTEGER NOT NULL CHECK (forgotten IN (0, 1)),    -- tombstone
  seq           INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, stream_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX progress_account_seq ON progress (account_id, seq);

CREATE TABLE dismissals (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  item_type   TEXT NOT NULL CHECK (item_type IN ('movie', 'series')),
  reason      TEXT CHECK (reason IN ('not_interested', 'seen')),   -- NULL = undone (tombstone)
  updated_at  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, item_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX dismissals_account_seq ON dismissals (account_id, seq);

CREATE TABLE feature_prefs (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  feature     TEXT NOT NULL,
  value       INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),     -- 0 = cleared (tombstone)
  updated_at  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, feature)
) WITHOUT ROWID, STRICT;
CREATE INDEX feature_prefs_account_seq ON feature_prefs (account_id, seq);
