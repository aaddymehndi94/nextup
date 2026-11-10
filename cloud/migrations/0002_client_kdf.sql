-- Client-side key stretching (see src/crypto.ts). The client derives PBKDF2-SHA256(password, salt, 600000)
-- and the server stores only HMAC-SHA256(server salt, key) in accounts.password_hash, now in the format
-- nxk1$<iterations>$<client salt>$<server salt>$<hmac>. Hashes in the old server-side format
-- (pbkdf2-sha256$…) can't be checked any more, because the server never sees a password now; nothing was
-- deployed with them, and an admin reset link fixes any local test account.

-- Random keys the Worker needs that aren't worth a deployed secret.
--   prelogin: HMAC key for the fake salts that /v1/auth/prelogin returns for emails without an account.
CREATE TABLE server_keys (
  name   TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) WITHOUT ROWID, STRICT;

INSERT INTO server_keys (name, value) VALUES ('prelogin', lower(hex(randomblob(32))));
