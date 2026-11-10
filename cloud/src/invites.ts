import { type AccountRow, accountJson, authenticate, RESET_TTL_MS, requireAdmin } from './auth.ts'
import { hashPassword, randomToken, sha256Hex, TOKEN } from './crypto.ts'
import { type Ctx, empty, type Env, HttpError, json, onlyKeys, readJson } from './http.ts'
import { displayName, email, newPassword, plainText, str, UUID } from './validate.ts'

// Invite-only sign-up (any member can invite; links are single-use and expire after 7 days) and the
// admin endpoints: list accounts, disable/enable, reset links, list and revoke any invite.

export const INVITE_TTL_MS = 7 * 24 * 3600_000
const PENDING_LIMIT = { member: 10, admin: 100 }
const SMALL_BODY = 4096

interface InviteRow {
  id: string
  created_by: string | null
  role: 'admin' | 'member'
  note: string | null
  created_at: number
  expires_at: number
  used_at: number | null
  used_by: string | null
  revoked_at: number | null
}

type Person = { id: string; email: string; displayName: string | null } | null

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked'

function status (r: InviteRow, now: number): InviteStatus {
  if (r.used_at !== null) return 'used'
  if (r.revoked_at !== null) return 'revoked'
  return r.expires_at <= now ? 'expired' : 'pending'
}

const person = (id: string | null, mail: string | null, name: string | null): Person =>
  id && mail ? { id, email: mail, displayName: name } : null

type InviteListRow = InviteRow & { u_email: string | null; u_name: string | null; c_email: string | null; c_name: string | null }

function inviteJson (r: InviteListRow, now: number, withCreator: boolean) {
  return {
    id: r.id,
    note: r.note,
    role: r.role,
    status: status(r, now),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    usedBy: person(r.used_by, r.u_email, r.u_name),
    revokedAt: r.revoked_at,
    ...(withCreator ? { createdBy: person(r.created_by, r.c_email, r.c_name) } : {}),
  }
}

const INVITE_SELECT = `SELECT i.*, u.email AS u_email, u.display_name AS u_name, c.email AS c_email, c.display_name AS c_name
                         FROM invites i LEFT JOIN accounts u ON u.id = i.used_by LEFT JOIN accounts c ON c.id = i.created_by`

export const inviteUrl = (env: Env, token: string) => `${env.PUBLIC_URL.replace(/\/+$/, '')}/join#${token}`
const resetUrl = (env: Env, token: string) => `${env.PUBLIC_URL.replace(/\/+$/, '')}/reset#${token}`

// ---- Members -------------------------------------------------------------------------

export async function createInvite (ctx: Ctx): Promise<Response> {
  const { account } = await authenticate(ctx)
  let note: string | null = null
  if (ctx.req.headers.get('content-length') !== '0' && ctx.req.body) {
    const body = await readJson(ctx.req, SMALL_BODY)
    onlyKeys(body, ['note'])
    if (body.note !== undefined && body.note !== null) note = plainText(body.note, 'note', 80)
  }
  const { env, now } = ctx
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
    .bind(account.id, now).first<{ n: number }>()
  const limit = PENDING_LIMIT[account.role]
  if ((pending?.n ?? 0) >= limit) throw new HttpError(409, 'too_many_invites', `You already have ${limit} unused invites. Revoke one or wait for them to expire.`)
  const token = randomToken('nxi_')
  const id = crypto.randomUUID()
  const expiresAt = now + INVITE_TTL_MS
  await env.DB.prepare(`INSERT INTO invites (id, token_hash, created_by, role, note, created_at, expires_at) VALUES (?, ?, ?, 'member', ?, ?, ?)`)
    .bind(id, await sha256Hex(token), account.id, note, now, expiresAt).run()
  return json({
    invite: { id, note, role: 'member', status: 'pending', createdAt: now, expiresAt, usedAt: null, usedBy: null, revokedAt: null },
    token,
    url: inviteUrl(env, token),
  }, 201)
}

export async function listMyInvites (ctx: Ctx): Promise<Response> {
  const { account } = await authenticate(ctx)
  const rows = await ctx.env.DB.prepare(`${INVITE_SELECT} WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT 200`).bind(account.id).all<InviteListRow>()
  return json({ invites: rows.results.map(r => inviteJson(r, ctx.now, false)) })
}

async function revoke (ctx: Ctx, id: string, byAccount: AccountRow, any: boolean): Promise<Response> {
  if (!UUID.test(id)) throw new HttpError(404, 'not_found', 'No such invite')
  const r = await ctx.env.DB.prepare('SELECT * FROM invites WHERE id = ?').bind(id).first<InviteRow>()
  if (!r || (!any && r.created_by !== byAccount.id)) throw new HttpError(404, 'not_found', 'No such invite')
  if (r.used_at !== null) throw new HttpError(409, 'already_used', 'That invite has already been used')
  if (r.revoked_at === null) {
    await ctx.env.DB.prepare('UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
      .bind(ctx.now, byAccount.id, id).run()
  }
  return empty()
}

export async function revokeMyInvite (ctx: Ctx): Promise<Response> {
  const { account } = await authenticate(ctx)
  return revoke(ctx, ctx.params[0], account, account.role === 'admin')
}

/** Sign up with an invite token. Returns the new account; the client then logs in. */
export async function acceptInvite (ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['token', 'email', 'password', 'displayName'])
  const token = str(body.token, 'token')
  const mail = email(body.email)
  const password = newPassword(body.password)
  const name = displayName(body.displayName)
  const { env, now } = ctx
  const invalid = new HttpError(400, 'invalid_invite', 'This invite link is invalid, already used or expired. Ask for a new one.')
  if (!TOKEN.test(token) || !token.startsWith('nxi_')) throw invalid
  const tokenHash = await sha256Hex(token)
  // Valid = unused, unrevoked, unexpired, and its creator (if any; NULL is the bootstrap invite) still enabled.
  const VALID = `i.token_hash = ?1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?2
                 AND (i.created_by IS NULL OR EXISTS (SELECT 1 FROM accounts c WHERE c.id = i.created_by AND c.disabled_at IS NULL))`
  const [inv, taken] = await env.DB.batch<{ id: string; role: 'admin' | 'member'; created_by: string | null } | { one: number }>([
    env.DB.prepare(`SELECT i.id, i.role, i.created_by FROM invites i WHERE ${VALID}`).bind(tokenHash, now),
    env.DB.prepare('SELECT 1 AS one FROM accounts WHERE email = ?').bind(mail),
  ])
  const invite = inv.results[0] as { id: string; role: 'admin' | 'member'; created_by: string | null } | undefined
  if (!invite) throw invalid
  if (taken.results.length) throw new HttpError(409, 'email_taken', 'An account with that email already exists')

  const hash = await hashPassword(password)
  const id = crypto.randomUUID()
  // One transaction: the account is only inserted while the invite is still valid, then the invite is
  // marked used. Two simultaneous sign-ups with one token: the second inserts nothing.
  let results: D1Result[]
  try {
    results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO accounts (id, email, display_name, role, password_hash, invited_by, created_at, password_changed_at)
                      SELECT ?3, ?4, ?5, i.role, ?6, i.created_by, ?2, ?2 FROM invites i WHERE ${VALID}`)
        .bind(tokenHash, now, id, mail, name, hash),
      env.DB.prepare('UPDATE invites SET used_at = ?2, used_by = ?3 WHERE token_hash = ?1 AND used_at IS NULL AND EXISTS (SELECT 1 FROM accounts WHERE id = ?3)')
        .bind(tokenHash, now, id),
      // Using a bootstrap invite retires any other unused bootstrap invites.
      env.DB.prepare(`UPDATE invites SET revoked_at = ?2 WHERE created_by IS NULL AND used_at IS NULL AND revoked_at IS NULL AND token_hash != ?1
                        AND EXISTS (SELECT 1 FROM accounts WHERE id = ?3 AND invited_by IS NULL)`).bind(tokenHash, now, id),
    ])
  } catch (err) {
    if (/UNIQUE/i.test(String((err as Error).message))) throw new HttpError(409, 'email_taken', 'An account with that email already exists')
    throw err
  }
  if (results[0].meta.changes !== 1) throw invalid
  const account: AccountRow = {
    id, email: mail, display_name: name, role: invite.role, password_hash: hash, invited_by: invite.created_by,
    created_at: now, password_changed_at: now, disabled_at: null, last_seen_at: null, sync_seq: 0,
  }
  return json({ account: accountJson(account) }, 201)
}

// ---- Admin ---------------------------------------------------------------------------

type AdminAccountRow = AccountRow & { inv_email: string | null; inv_name: string | null }

export async function adminListAccounts (ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx)
  const rows = await ctx.env.DB.prepare(`SELECT a.*, inv.email AS inv_email, inv.display_name AS inv_name
                                           FROM accounts a LEFT JOIN accounts inv ON inv.id = a.invited_by ORDER BY a.created_at`).all<AdminAccountRow>()
  return json({
    accounts: rows.results.map(a => ({
      ...accountJson(a),
      invitedBy: person(a.invited_by, a.inv_email, a.inv_name),
      disabledAt: a.disabled_at,
      lastSeenAt: a.last_seen_at,
    })),
  })
}

async function targetAccount (ctx: Ctx): Promise<AccountRow> {
  const id = ctx.params[0]
  const a = UUID.test(id) ? await ctx.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>() : null
  if (!a) throw new HttpError(404, 'not_found', 'No such account')
  return a
}

/** Disables an account: its sessions end, its unused invites are revoked, it can't sign in. */
export async function adminDisable (ctx: Ctx): Promise<Response> {
  const { account: admin } = await requireAdmin(ctx)
  const a = await targetAccount(ctx)
  if (a.id === admin.id) throw new HttpError(409, 'self', "You can't disable your own account")
  const { env, now } = ctx
  const disabledAt = a.disabled_at ?? now
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').bind(disabledAt, a.id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(a.id),
    env.DB.prepare('UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL').bind(now, admin.id, a.id),
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL').bind(now, a.id),
  ])
  return json({ account: { ...accountJson(a), disabledAt } })
}

export async function adminEnable (ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx)
  const a = await targetAccount(ctx)
  await ctx.env.DB.prepare('UPDATE accounts SET disabled_at = NULL WHERE id = ?').bind(a.id).run()
  return json({ account: { ...accountJson(a), disabledAt: null } })
}

/** A single-use link (24 h) that lets the account holder set a new password. Earlier unused links stop working. */
export async function adminResetLink (ctx: Ctx): Promise<Response> {
  const { account: admin } = await requireAdmin(ctx)
  const a = await targetAccount(ctx)
  if (a.disabled_at !== null) throw new HttpError(409, 'account_disabled', 'Enable the account first')
  const { env, now } = ctx
  const token = randomToken('nxr_')
  const expiresAt = now + RESET_TTL_MS
  await env.DB.batch([
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL').bind(now, a.id),
    env.DB.prepare('INSERT INTO password_resets (token_hash, account_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), a.id, admin.id, now, expiresAt),
  ])
  return json({ token, url: resetUrl(env, token), expiresAt }, 201)
}

export async function adminListInvites (ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx)
  const rows = await ctx.env.DB.prepare(`${INVITE_SELECT} ORDER BY i.created_at DESC LIMIT 500`).all<InviteListRow>()
  return json({ invites: rows.results.map(r => inviteJson(r, ctx.now, true)) })
}

export async function adminRevokeInvite (ctx: Ctx): Promise<Response> {
  const { account } = await requireAdmin(ctx)
  return revoke(ctx, ctx.params[0], account, true)
}
