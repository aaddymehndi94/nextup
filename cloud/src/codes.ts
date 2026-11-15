import { accountJson, type AccountRow, clientIp, createSession, failure, lockedFor, serverKey, SIGNUP_THROTTLE, THROTTLE, tooManyAttempts } from './auth.ts'
import { b64url, keyedHash, sha256Hex, timingSafeEqual } from './crypto.ts'
import { bad, type Ctx, HttpError, json, type Mail, onlyKeys, readJson } from './http.ts'
import { displayName, email, str } from './validate.ts'

// Signing in with a code sent by email, the same for a new account and an existing one, so there's no
// password to forget or reset: POST /v1/auth/code sends a 6-digit code, POST /v1/auth/code/verify trades it
// for a session, creating the account the first time. Both answer the same whether or not the email has an
// account. Codes go out through Cloudflare Email Service (env.EMAIL); see README.md, "Sign-in codes".
//
// Guessing: each code takes 5 tries and lasts 10 minutes, and an email gets at most 5 codes an hour and 10 a
// day, so at most 50 guesses a day at a million codes, while the inbox's owner sees every code arrive.
// Accounts made before codes keep their password verifier, for apps before 0.5.5; new ones have none.

const MINUTE = 60_000
export const CODE_TTL_MS = 10 * MINUTE
export const CODE_TRIES = 5
export const SEND_THROTTLE = {
  hour: { windowMs: 60 * MINUTE, lockMs: 60 * MINUTE, perEmail: 5, perIp: 20 },
  day: { windowMs: 24 * 60 * MINUTE, lockMs: 24 * 60 * MINUTE, perEmail: 10 },
}
export const FROM = { email: 'sign-in@nexttupp.com', name: 'nexttupp' }
const SMALL_BODY = 4096
const CODE = /^\d{6}$/
const enc = new TextEncoder()

/** Six digits, uniform: 4,294,000,000 is the largest multiple of a million below 2^32. */
function newCode (): string {
  const n = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(n)
    if (n[0] < 4_294_000_000) return String(n[0] % 1_000_000).padStart(6, '0')
  }
}

const hmac = async (key: string, message: string) => b64url(await keyedHash(key, message))
const hashes = async (key: string, mail: string, code: string) =>
  ({ email: await hmac(key, `code-email:${mail}`), code: await hmac(key, `code:${mail}:${code}`) })

export function codeMail (to: string, code: string): Mail {
  const lines = ['Type it where you asked for it. It works once, for the next 10 minutes.', 'Didn’t ask for it? Ignore this email: nobody gets in without the code.']
  return {
    from: FROM,
    to,
    subject: `${code} is your nexttupp code`,
    text: `${code} is your nexttupp code.\n\n${lines[0]}\n\n${lines[1]}\n`,
    html: `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#ffffff;color:#161618;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:420px;margin:0 auto">
<p style="margin:0 0 8px;font-size:15px;color:#5c5c63">Your nexttupp code</p>
<p style="margin:0 0 24px;font-size:40px;line-height:1.1;font-weight:700;letter-spacing:0.12em">${code}</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${lines[0]}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#5c5c63">${lines[1]}</p>
</div></body></html>`,
  }
}

const unavailable = () => new HttpError(503, 'email_unavailable', 'We can’t send email right now. Try again in a little while.')

/** POST /v1/auth/code `{ email }`: emails a 6-digit code. Asking again replaces the code. */
export async function sendCode (ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['email'])
  const mail = email(body.email)
  const { env, now } = ctx
  if (!env.EMAIL) throw unavailable()
  // Throttle keys are hashed, like login's, so login_attempts holds no email or IP address.
  const keys = { hour: await sha256Hex(`ch:${mail}`), day: await sha256Hex(`cd:${mail}`), ip: await sha256Hex(`ci:${clientIp(ctx.req)}`) }
  const wait = await lockedFor(env, [keys.hour, keys.day, keys.ip], now)
  if (wait > 0) throw tooManyAttempts(wait, 'codes in a row')

  const code = newCode()
  const h = await hashes(await serverKey(env), mail, code)
  const { hour, day } = SEND_THROTTLE
  await env.DB.batch([
    failure(env, keys.hour, hour.perEmail, now, hour.windowMs, hour.lockMs),
    failure(env, keys.day, day.perEmail, now, day.windowMs, day.lockMs),
    failure(env, keys.ip, hour.perIp, now, hour.windowMs, hour.lockMs),
    env.DB.prepare('DELETE FROM email_codes WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE updated_at < ?1 AND locked_until < ?2').bind(now - day.windowMs, now),
    env.DB.prepare(`INSERT INTO email_codes (email_hash, code_hash, created_at, expires_at, attempts) VALUES (?1, ?2, ?3, ?4, 0)
                    ON CONFLICT (email_hash) DO UPDATE SET code_hash = ?2, created_at = ?3, expires_at = ?4, attempts = 0`)
      .bind(h.email, h.code, now, now + CODE_TTL_MS),
  ])
  try {
    await env.EMAIL.send(codeMail(mail, code))
  } catch (err) {
    await env.DB.prepare('DELETE FROM email_codes WHERE email_hash = ? AND code_hash = ?').bind(h.email, h.code).run()
    const why = String((err as { code?: unknown }).code ?? (err as Error).message ?? 'unknown')
    console.error(`sign-in code not sent: ${why}`)
    if (/RECIPIENT/i.test(why)) throw new HttpError(422, 'email_undeliverable', 'We couldn’t send to that address. Check it and try again.')
    throw unavailable()
  }
  return json({ sent: true, expiresAt: now + CODE_TTL_MS })
}

/**
 * POST /v1/auth/code/verify `{ email, code, displayName? }`: a session, and `created: true` if this made the
 * account (displayName is only used then). Every try uses up one of the code's tries first, so tries running
 * at once can't get past the limit.
 */
export async function verifyCode (ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['email', 'code', 'displayName'])
  const mail = email(body.email)
  const code = str(body.code, 'code').replace(/[\s-]/g, '')
  if (!CODE.test(code)) throw bad('code: must be the 6 digits from the email')
  const name = displayName(body.displayName)
  const { env, now } = ctx
  const ip = clientIp(ctx.req)
  const ipKey = await sha256Hex(`i:${ip}`) // shared with password login: one budget of wrong tries per network
  const wait = await lockedFor(env, [ipKey], now)
  if (wait > 0) throw tooManyAttempts(wait)

  const h = await hashes(await serverKey(env), mail, code)
  const expired = () => new HttpError(401, 'invalid_code', 'That code has expired or was already used. Ask for a new code.')
  const row = await env.DB.prepare(`UPDATE email_codes SET attempts = attempts + 1 WHERE email_hash = ? AND expires_at > ? AND attempts < ?
                                    RETURNING code_hash, attempts`).bind(h.email, now, CODE_TRIES).first<{ code_hash: string; attempts: number }>()
  if (!row) throw expired()
  if (!timingSafeEqual(enc.encode(row.code_hash), enc.encode(h.code))) {
    await failure(env, ipKey, THROTTLE.ipFailures, now).run()
    const left = CODE_TRIES - row.attempts
    throw new HttpError(401, 'invalid_code', left > 0
      ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
      : 'That code isn’t right, and it has stopped working. Ask for a new code.')
  }

  let account = await env.DB.prepare('SELECT * FROM accounts WHERE email = ?').bind(mail).first<AccountRow>()
  const signupKey = await sha256Hex(`s:${ip}`)
  if (!account) {
    const w = await lockedFor(env, [signupKey], now)
    if (w > 0) throw tooManyAttempts(w, 'new accounts from this network')
  }
  // The code is spent here, once: of two tries with it at the same moment, one gets the session.
  if (!await env.DB.prepare('DELETE FROM email_codes WHERE email_hash = ? AND code_hash = ? RETURNING 1 AS one').bind(h.email, h.code).first()) throw expired()

  let created = false
  if (!account) {
    await failure(env, signupKey, SIGNUP_THROTTLE.ipSignups, now, SIGNUP_THROTTLE.windowMs, SIGNUP_THROTTLE.lockMs).run()
    // No password: password_hash is empty, which no key ever matches (crypto.ts checkKey).
    const inserted = await env.DB.prepare(`INSERT INTO accounts (id, email, display_name, role, password_hash, created_at, password_changed_at)
                                           VALUES (?1, ?2, ?3, 'member', '', ?4, ?4) ON CONFLICT (email) DO NOTHING RETURNING *`)
      .bind(crypto.randomUUID(), mail, name, now).first<AccountRow>()
    created = inserted !== null
    account = inserted ?? await env.DB.prepare('SELECT * FROM accounts WHERE email = ?').bind(mail).first<AccountRow>()
    if (!account) throw new HttpError(500, 'internal', 'Something went wrong')
  }
  if (account.disabled_at !== null) throw new HttpError(403, 'account_disabled', 'This account has been disabled')
  const session = await createSession(env, account.id, now)
  return json({ ...session, account: accountJson(account), created })
}
