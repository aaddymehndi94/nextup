-- Group invites: one link that several people can join with (up to max_uses), for sharing in a group chat.
-- A one-person invite is max_uses = 1, which is what every existing invite becomes.
--
-- used_at keeps its meaning, "this link can't be used any more": it is set when the last place is taken.
-- used_by is the first person who joined with it. accounts.invite_id records which invite each person used,
-- so the person who made a group link can see everyone who joined with it.

ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 50);
ALTER TABLE invites ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
UPDATE invites SET use_count = 1 WHERE used_at IS NOT NULL;

ALTER TABLE accounts ADD COLUMN invite_id TEXT REFERENCES invites (id) ON DELETE SET NULL;
UPDATE accounts SET invite_id = (SELECT i.id FROM invites i WHERE i.used_by = accounts.id ORDER BY i.used_at LIMIT 1);
CREATE INDEX accounts_invite ON accounts (invite_id);
