-- Music sync (src/music.ts, README.md "Music"). The music taste of each account: likes, listens and the mixes
-- people asked for, plus the songs and artists those rows name, so another computer can show them. Like the
-- film tables, every row is scoped by account_id in its key (nothing is shared between accounts) and carries
-- seq from the account's one counter. Song and artist ids are made by the app from normalised names.
-- Never stored: downloaded files, YouTube ids, the engine's own mixes, AI settings.

-- The counter value of the account's last music push. The film pull reports it as musicHead, so clients skip
-- the music pull when nothing changed, and its presence tells them this Worker syncs music.
ALTER TABLE accounts ADD COLUMN music_seq INTEGER NOT NULL DEFAULT 0;

-- Catalog facts. A push only fills gaps (a missing picture, album or duration), never overwrites.
CREATE TABLE music_artists (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,                                   -- a + 12 hex
  name        TEXT NOT NULL,
  picture     TEXT,                                            -- https, Deezer or Apple image servers only
  itunes_id   TEXT,
  deezer_id   TEXT,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
) WITHOUT ROWID, STRICT;
CREATE INDEX music_artists_account_seq ON music_artists (account_id, seq);

CREATE TABLE music_tracks (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,                                   -- t + 16 hex
  title       TEXT NOT NULL,
  credit      TEXT,
  artist_id   TEXT NOT NULL,
  artist      TEXT NOT NULL,
  picture     TEXT,
  album_id    TEXT,                                            -- it… or dz…
  album       TEXT,
  cover       TEXT,
  duration    INTEGER NOT NULL,                                -- seconds
  explicit    INTEGER NOT NULL CHECK (explicit IN (0, 1)),
  rank        REAL NOT NULL,                                   -- popularity, 0–1
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
) WITHOUT ROWID, STRICT;
CREATE INDEX music_tracks_account_seq ON music_tracks (account_id, seq);

CREATE TABLE music_ratings (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('track', 'artist')),
  item_id     TEXT NOT NULL,
  value       INTEGER NOT NULL CHECK (value IN (-1, 0, 1)),     -- 0 = cleared (kept, like the film tombstones)
  name        TEXT,
  picture     TEXT,
  updated_at  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, profile_id, kind, item_id)
) WITHOUT ROWID, STRICT;
CREATE INDEX music_ratings_account_seq ON music_ratings (account_id, seq);

-- Immutable, insert-once by id.
CREATE TABLE music_listens (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,                                   -- UUIDv7 from the client
  profile_id  TEXT NOT NULL,
  track_id    TEXT NOT NULL,
  artist_id   TEXT NOT NULL,
  played      REAL NOT NULL,                                   -- seconds heard
  outcome     TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'skip')),
  at          INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
) WITHOUT ROWID, STRICT;
CREATE INDEX music_listens_account_seq ON music_listens (account_id, seq);

-- Only the mixes someone asked for (AI and mood), newest 12 per profile.
CREATE TABLE music_mixes (
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,                                   -- m + 15 hex
  profile_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('ai', 'mood')),
  title       TEXT NOT NULL,
  subtitle    TEXT NOT NULL,
  tracks      TEXT NOT NULL,                                   -- JSON [{ id, why }], validated and re-serialised by the Worker
  model       TEXT,
  at          INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
) WITHOUT ROWID, STRICT;
CREATE INDEX music_mixes_account_seq ON music_mixes (account_id, seq);
