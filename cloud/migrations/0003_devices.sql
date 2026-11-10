-- Watch at home: computers running nexttupp register here so a phone signed in to the same account can find
-- them on its Wi-Fi, plus the one-time codes that hand a phone over to one of them. See README.md, "Devices
-- and phone handoff".

-- One row per nexttupp install that is signed in. The id is random, chosen by the app, and only unique
-- within the account. lan_urls is a JSON array of http://<private IPv4>:<port> addresses (empty when the
-- person turned "Watch on phones and TVs at home" off). net_hash is HMAC-SHA256(server key, the IP the
-- device last called from; for IPv6 its /64), so the API can say "same network" without keeping any IP.
CREATE TABLE devices (
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('linux', 'mac', 'windows', 'other')),
  lan           INTEGER NOT NULL CHECK (lan IN (0, 1)),
  lan_urls      TEXT NOT NULL,
  net_hash      TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
) WITHOUT ROWID, STRICT;
CREATE INDEX devices_last_seen ON devices (last_seen_at);

-- Phone handoff codes: single-use, 60 seconds, bound to one account and one device. Only the SHA-256 is kept.
CREATE TABLE handoffs (
  code_hash   TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) WITHOUT ROWID, STRICT;
CREATE INDEX handoffs_account ON handoffs (account_id, expires_at);
CREATE INDEX handoffs_expires ON handoffs (expires_at);
