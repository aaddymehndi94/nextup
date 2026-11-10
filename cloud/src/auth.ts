import { checkKey, DUMMY_VERIFIER, fakeSalt, KDF, KDF_ITERATIONS, kdfParams, makeVerifier, randomToken, sha256Hex, TOKEN } from './crypto.ts'
import { type Ctx, empty, type Env, HttpError, json, onlyKeys, readJson } from './http.ts'
import { authKey, credential, displayName, str } from './validate.ts'

// Accounts, sessions, login throttling, password change and admin-issued password resets. Passwords are
// stretched by the client; the server only ever sees the derived key (see crypto.ts).

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** Sessions expire after this long unused; each day of use pushes the expiry out again. */
export const SESSION_IDLE_MS = 90 * DAY
const SESSION_TOUCH_MS = DAY
const MAX_SESSIONS = 20
export const RESET_TTL_MS = DAY

/** Login throttling: failures per key inside a window, then a lock. Checked before the key is compared. */
export const THROTTLE = {
  windowMs: 15 * MINUTE,
  lockMs: 15 * MINUTE,
  emailFailures: 5,
  ipFailures: 30,
}

const SMALL_BODY = 4096

export interface AccountRow {
  id: string
  email: string
  display_name: string | null
  role: 'admin' | 'member'
  /** The verifier for the client-derived key: nxk1$<iterations>$<client salt>$<server salt>$<hmac> */
  password_hash: string
  invited_by: string | null
  created_at: number
  password_changed_at: number
  disabled_at: number | null
  last_seen_at: number | null
  sync_seq: number
}

export interface AccountJson {
  id: string
  email: string
  displayName: string | null
  role: 'admin' | 'member'
  createdAt: number
  invitedBy: string | null
}

export const accountJson = (a: AccountRow): AccountJson => ({
  id: a.id,
  email: a.email,
  displayName: a.display_name,
  role: a.role,
  createdAt: a.created_at,
  invitedBy: a.invited_by,
})

export interface Session { account: AccountRow; tokenHash: string }

const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in again', { 'www-authenticate': 'Bearer' })

/** The account behind `Authorization: Bearer nxs_…`, or a 401/403. Extends the session once a day. */
export async function authenticate (ctx: Ctx): Promise<Session> {
  const m = /^Bearer\s+(\S+)$/i.exec(ctx.req.headers.get('authorization') ?? '')
  if (!m || !TOKEN.test(m[1]) || !m[1].startsWith('nxs_')) throw unauthorized()
  const tokenHash = await sha256Hex(m[1])
  const row = await ctx.env.DB.prepare(`SELECT s.expires_at AS s_expires_at, s.last_used_at AS s_last_used_at, a.*
                                          FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`)
    .bind(tokenHash).first<AccountRow & { s_expires_at: number; s_last_used_at: number }>()
  if (!row || row.s_expires_at <= ctx.now) {
    if (row) await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    throw unauthorized()
  }
  if (row.disabled_at !== null) throw new HttpError(403, 'account_disabled', 'This account has been disabled')
  if (ctx.now - row.s_last_used_at >= SESSION_TOUCH_MS) {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').bind(ctx.now, ctx.now + SESSION_IDLE_MS, tokenHash),
      ctx.env.DB.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?').bind(ctx.now, row.id),
    ])
  }
  const { s_expires_at: _e, s_last_used_at: _l, ...account } = row
  return { account, tokenHash }
}

export async function requireAdmin (ctx: Ctx): Promise<Session> {
  const s = await authenticate(ctx)
  if (s.account.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only an admin can do that')
  return s
}

export async function createSession (env: Env, accountId: string, now: number): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken('nxs_')
  const expiresAt = now + SESSION_IDLE_MS
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, account_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), accountId, now, now, expiresAt),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ? AND expires_at <= ?').bind(accountId, now),
    env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?1 AND token_hash NOT IN
                      (SELECT token_hash FROM sessions WHERE account_id = ?1 ORDER BY last_used_at DESC, created_at DESC LIMIT ?2)`).bind(accountId, MAX_SESSIONS),
    env.DB.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?').bind(now, accountId),
  ])
  return { token, expiresAt }
}

// ---- Throttling ------------------------------------------------------------------

/** Throttle keys are hashed so the table holds no emails or IP addresses. */
const throttleKeys = async (mail: string, ip: string) => ({ email: await sha256Hex(`e:${mail}`), ip: await sha256Hex(`i:${ip}`) })

export function clientIp (req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown'
}

async function lockedFor (env: Env, keys: string[], now: number): Promise<number> {
  const placeholders = keys.map(() => '?').join(', ')
  const r = await env.DB.prepare(`SELECT MAX(locked_until) AS until FROM login_attempts WHERE key IN (${placeholders})`).bind(...keys).first<{ until: number | null }>()
  return Math.max(0, (r?.until ?? 0) - now)
}

function tooManyAttempts (waitMs: number): HttpError {
  const s = Math.ceil(waitMs / 1000)
  return new HttpError(429, 'too_many_attempts', `Too many failed attempts. Try again in ${Math.ceil(s / 60)} min.`, { 'retry-after': String(s) })
}

function failure (env: Env, key: string, limit: number, now: number): D1PreparedStatement {
  // SET expressions all see the row as it was, so the "new failures" expression is repeated for the lock.
  return env.DB.prepare(`INSERT INTO login_attempts (key, failures, window_start, locked_until, updated_at)
                         VALUES (?1, 1, ?2, CASE WHEN ?4 <= 1 THEN ?2 + ?5 ELSE 0 END, ?2)
                         ON CONFLICT (key) DO UPDATE SET
                           failures = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE failures + 1 END,
                           window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END,
                           locked_until = CASE WHEN (CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE failures + 1 END) >= ?4 THEN ?2 + ?5 ELSE locked_until END,
                           updated_at = ?2`)
    .bind(key, now, THROTTLE.windowMs, limit, THROTTLE.lockMs)
}

// ---- Handlers ---------------------------------------------------------------------

// The prelogin key is a random value in D1 (migration 0002), read once per isolate.
let preloginKey: string | null = null

export async function serverKey (env: Env): Promise<string> {
  if (preloginKey) return preloginKey
  const [, row] = await env.DB.batch<{ value: string }>([
    env.DB.prepare("INSERT OR IGNORE INTO server_keys (name, value) VALUES ('prelogin', lower(hex(randomblob(32))))"),
    env.DB.prepare("SELECT value FROM server_keys WHERE name = 'prelogin'"),
  ])
  preloginKey = (row.results[0] as { value: string }).value
  return preloginKey
}

/**
 * The KDF parameters for an email: `{ kdf, iterations, salt }`. An email without an account gets a
 * deterministic fake salt, so this doesn't reveal who has an account. Costs one HMAC either way.
 */
export async function prelogin (ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['email'])
  const mail = str(body.email, 'email').trim().toLowerCase().slice(0, 254)
  const [row, key] = await Promise.all([
    ctx.env.DB.prepare('SELECT password_hash FROM accounts WHERE email = ?').bind(mail).first<{ password_hash: string }>(),
    serverKey(ctx.env),
  ])
  const fake = await fakeSalt(key, mail)
  const real = row ? kdfParams(row.password_hash) : null
  return json({ kdf: KDF, iterations: real?.iterations ?? KDF_ITERATIONS, salt: real?.salt ?? fake })
}

export async function login (ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['email', 'key'])
  const mail = str(body.email, 'email').trim().toLowerCase().slice(0, 254)
  const key = authKey(body.key)
  const { env, now } = ctx
  const keys = await throttleKeys(mail, clientIp(ctx.req))

  const [locks, accounts] = await env.DB.batch<{ until: number | null } | AccountRow>([
    env.DB.prepare('SELECT MAX(locked_until) AS until FROM login_attempts WHERE key IN (?, ?)').bind(keys.email, keys.ip),
    env.DB.prepare('SELECT * FROM accounts WHERE email = ?').bind(mail),
    env.DB.prepare('DELETE FROM login_attempts WHERE updated_at < ? AND locked_until < ?').bind(now - DAY, now),
  ])
  const until = (locks.results[0] as { until: number | null } | undefined)?.until ?? 0
  if (until > now) throw tooManyAttempts(until - now)
  const account = accounts.results[0] as AccountRow | undefined

  const ok = await checkKey(key, account?.password_hash ?? DUMMY_VERIFIER)
  if (!ok || !account) {
    await env.DB.batch([failure(env, keys.email, THROTTLE.emailFailures, now), failure(env, keys.ip, THROTTLE.ipFailures, now)])
    throw new HttpError(401, 'invalid_credentials', 'Wrong email or password')
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(keys.email).run()
  if (account.disabled_at !== null) throw new HttpError(403, 'account_disabled', 'This account has been disabled')
  const session = await createSession(env, account.id, now)
  return json({ ...session, account: accountJson(account) })
}

export async function logout (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  let all = false
  if (ctx.req.headers.get('content-length') !== '0' && ctx.req.body) {
    const body = await readJson(ctx.req, SMALL_BODY)
    onlyKeys(body, ['all'])
    if (body.all !== undefined && typeof body.all !== 'boolean') throw new HttpError(400, 'invalid', 'all: must be a boolean')
    all = body.all === true
  }
  if (all) await ctx.env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(s.account.id).run()
  else await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(s.tokenHash).run()
  return empty()
}

export async function getAccount (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  return json({ account: accountJson(s.account) })
}

export async function patchAccount (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['displayName'])
  if (!('displayName' in body)) return json({ account: accountJson(s.account) })
  const name = displayName(body.displayName)
  await ctx.env.DB.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').bind(name, s.account.id).run()
  return json({ account: accountJson({ ...s.account, display_name: name }) })
}

/** Needs the current key (derived with the old salt) and a new credential; signs out every other session. */
export async function changePassword (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['currentKey', 'salt', 'iterations', 'key'])
  const current = authKey(body.currentKey, 'currentKey')
  const next = credential(body)
  const { env, now } = ctx
  const keys = await throttleKeys(s.account.email, clientIp(ctx.req))
  const wait = await lockedFor(env, [keys.email, keys.ip], now)
  if (wait > 0) throw tooManyAttempts(wait)
  if (!await checkKey(current, s.account.password_hash)) {
    await env.DB.batch([failure(env, keys.email, THROTTLE.emailFailures, now), failure(env, keys.ip, THROTTLE.ipFailures, now)])
    throw new HttpError(403, 'wrong_password', 'The current password is wrong')
  }
  const hash = await makeVerifier(next.key, next.salt, next.iterations)
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET password_hash = ?, password_changed_at = ? WHERE id = ?').bind(hash, now, s.account.id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?').bind(s.account.id, s.tokenHash),
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL').bind(now, s.account.id),
    env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(keys.email),
  ])
  return empty()
}

/** Sets a new password with an admin-issued reset token. Signs out every session; the client then logs in. */
export async function resetPassword (ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['token', 'salt', 'iterations', 'key'])
  const token = str(body.token, 'token')
  const next = credential(body)
  const { env, now } = ctx
  const invalid = new HttpError(400, 'invalid_token', 'This reset link is invalid or has expired. Ask the admin for a new one.')
  if (!TOKEN.test(token) || !token.startsWith('nxr_')) throw invalid
  const tokenHash = await sha256Hex(token)
  const r = await env.DB.prepare(`SELECT r.account_id, a.email, a.disabled_at FROM password_resets r JOIN accounts a ON a.id = r.account_id
                                  WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`)
    .bind(tokenHash, now).first<{ account_id: string; email: string; disabled_at: number | null }>()
  if (!r) throw invalid
  if (r.disabled_at !== null) throw new HttpError(403, 'account_disabled', 'This account has been disabled')
  const hash = await makeVerifier(next.key, next.salt, next.iterations)
  const keys = await throttleKeys(r.email, '')
  // The password only changes if the token is still unused when the batch runs (it is one transaction);
  // the follow-up statements key off the new hash, which is unique, so a lost race changes nothing.
  const [set] = await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET password_hash = ?1, password_changed_at = ?2 WHERE id = ?3
                      AND EXISTS (SELECT 1 FROM password_resets WHERE token_hash = ?4 AND used_at IS NULL AND expires_at > ?2)`)
      .bind(hash, now, r.account_id, tokenHash),
    env.DB.prepare(`UPDATE password_resets SET used_at = ?1 WHERE account_id = ?2 AND used_at IS NULL
                      AND (SELECT password_hash FROM accounts WHERE id = ?2) = ?3`).bind(now, r.account_id, hash),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?1 AND (SELECT password_hash FROM accounts WHERE id = ?1) = ?2').bind(r.account_id, hash),
    env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(keys.email),
  ])
  if (set.meta.changes !== 1) throw invalid
  return empty()
}
