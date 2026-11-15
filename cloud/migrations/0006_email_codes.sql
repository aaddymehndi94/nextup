-- Sign-in codes sent by email (src/codes.ts). One live code per email address: asking again replaces it.
-- Both the address and the code are HMACs under the server key, so the table holds no email address of
-- someone who asked for a code and never used it, and no code that could be read back. A row goes when
-- its code is used, replaced or fails to send. One out of tries waits for its expiry; expired rows are swept
-- on a later send.
CREATE TABLE email_codes (
  email_hash TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX email_codes_expiry ON email_codes (expires_at);
