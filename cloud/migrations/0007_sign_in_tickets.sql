-- "Continue with Google" (src/google.ts): Google sends the browser back here, and the browser goes on to the
-- site or the app with a one-time ticket in the URL fragment. Only the SHA-256 of the ticket is kept, with the
-- challenge (SHA-256 of a secret the starter kept), so a ticket is useless to anyone else. A row goes when the
-- ticket is used or tried with the wrong secret; expired rows are swept on a later sign-in. Two minutes.
CREATE TABLE sign_in_tickets (
  ticket_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sign_in_tickets_expiry ON sign_in_tickets (expires_at);
