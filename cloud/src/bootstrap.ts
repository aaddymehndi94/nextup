import { randomToken, sha256Hex } from './crypto.ts'

// The one-time bootstrap: an admin invite inserted straight into D1 by whoever holds the Cloudflare
// account (`wrangler d1 execute`). Only the token's hash goes into the database; the token itself is
// printed once, for the owner. Unless forced, the INSERT is a no-op once any admin exists.

export const BOOTSTRAP_TTL_MS = 24 * 3600_000

export async function bootstrapInvite (opts: { now?: number; force?: boolean } = {}): Promise<{ token: string; sql: string; expiresAt: number }> {
  const now = opts.now ?? Date.now()
  const token = randomToken('nxi_')
  const expiresAt = now + BOOTSTRAP_TTL_MS
  // Every interpolated value is generated here (UUID, hex, integers), never user input.
  const values = `'${crypto.randomUUID()}', '${await sha256Hex(token)}', NULL, 'admin', 'bootstrap', ${now}, ${expiresAt}`
  const guard = opts.force ? '' : " WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'admin')"
  const sql = `INSERT INTO invites (id, token_hash, created_by, role, note, created_at, expires_at) SELECT ${values}${guard};`
  return { token, sql, expiresAt }
}
