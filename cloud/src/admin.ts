import { type AccountRow, accountJson, RESET_TTL_MS, requireAdmin } from './auth.ts'
import { randomToken, sha256Hex } from './crypto.ts'
import { type Ctx, HttpError, json } from './http.ts'
import { UUID } from './validate.ts'

// The admin endpoints: list accounts, disable/enable one, and make a password reset link. The first admin
// is promoted by hand in D1 (see README.md, "The first admin"); no endpoint can make one.

/** Reset links open this Worker's own /reset page, with the token in the fragment (never sent to a server). */
const resetUrl = (ctx: Ctx, token: string) => `${ctx.url.origin}/reset#${token}`

export async function adminListAccounts (ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx)
  const rows = await ctx.env.DB.prepare('SELECT * FROM accounts ORDER BY created_at').all<AccountRow>()
  return json({
    accounts: rows.results.map(a => ({ ...accountJson(a), disabledAt: a.disabled_at, lastSeenAt: a.last_seen_at })),
  })
}

async function targetAccount (ctx: Ctx): Promise<AccountRow> {
  const id = ctx.params[0]
  const a = UUID.test(id) ? await ctx.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>() : null
  if (!a) throw new HttpError(404, 'not_found', 'No such account')
  return a
}

/** Disables an account: its sessions end and it can't sign in. */
export async function adminDisable (ctx: Ctx): Promise<Response> {
  const { account: admin } = await requireAdmin(ctx)
  const a = await targetAccount(ctx)
  if (a.id === admin.id) throw new HttpError(409, 'self', "You can't disable your own account")
  const { env, now } = ctx
  const disabledAt = a.disabled_at ?? now
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').bind(disabledAt, a.id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(a.id),
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
  return json({ token, url: resetUrl(ctx, token), expiresAt }, 201)
}
