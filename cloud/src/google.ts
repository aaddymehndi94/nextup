import { accountJson, type AccountRow, clientIp, createSession, failure, lockedFor, serverKey, SIGNUP_THROTTLE } from './auth.ts'
import { b64url, fromB64url, keyedHash, randomToken, sha256Hex, timingSafeEqual } from './crypto.ts'
import { bad, type Ctx, type Env, HttpError, json, onlyKeys, readJson } from './http.ts'
import { email, str } from './validate.ts'

// "Continue with Google", for the website and the desktop app alike (OpenID Connect, authorization code + PKCE):
//   1. GET  /v1/auth/google?to=site|app&challenge=…[&back=/watch][&port=4545]
//      The site or app made a secret and sends only its SHA-256 (the challenge). We remember where to go back,
//      the challenge and a PKCE verifier in a signed, HttpOnly cookie, and send the browser to Google.
//   2. GET  /v1/auth/google/callback?code=…&state=…
//      Google sends the browser back. We swap the code for the person's ID token (straight from Google over
//      TLS, so its signature needn't be checked), find the account with that verified email or make one, and
//      send the browser on with a one-time ticket in the fragment, or an #error=….
//   3. POST /v1/auth/ticket { ticket, secret }
//      The site or app turns the ticket into a session. Only the secret behind the challenge works, once,
//      for two minutes: a ticket in someone else's link signs no one in.
// Matching by email means an account made earlier with a code or a password is the same account.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const COOKIE = 'nx_google'
const COOKIE_TTL_S = 600
export const TICKET_TTL_MS = 2 * 60_000
const B64 = /^[A-Za-z0-9_-]{43}$/
const TICKET = /^nxt_[A-Za-z0-9_-]{43}$/
const SITE_PAGES = ['/account', '/watch']
const enc = new TextEncoder()

/** The one call to Google: an authorization code for the ID token's claims. Tests stand in for it (env.GOOGLE). */
export interface GoogleSignIn {
  exchange (code: string, verifier: string, redirectUri: string): Promise<Record<string, unknown>>
}

/**
 * Google, or for a local test cloud only (`wrangler dev --var DEV_FAKE_GOOGLE:on`, on localhost) a stand-in whose
 * "code" is `email` or `email|First name` (scripts/sync-e2e.mjs). Any other host refuses the stand-in.
 */
function googleOf (env: Env, origin: string): GoogleSignIn {
  if (env.GOOGLE) return env.GOOGLE
  if (env.DEV_FAKE_GOOGLE === 'on') {
    return {
      async exchange (code) {
        if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error('the stand-in for Google only runs on localhost')
        const [mail, name] = code.split('|')
        return { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, email: mail, email_verified: true, given_name: name, exp: Math.floor(Date.now() / 1000) + 600 }
      },
    }
  }
  return {
    async exchange (code, verifier, redirectUri) {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
          client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        }),
      })
      if (!res.ok) throw new Error(`google token ${res.status}`)
      const idToken = String(((await res.json()) as { id_token?: unknown }).id_token ?? '')
      const payload = fromB64url(idToken.split('.')[1] ?? '')
      if (!payload) throw new Error('google token: no ID token')
      return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
    },
  }
}

interface Pending { s: string; v: string; to: 'site' | 'app'; port?: number; back?: string; c: string; exp: number }

const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)))
const s256 = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
const site = (env: Env) => (env.SITE_URL ?? 'https://nexttupp.com').replace(/\/$/, '')

async function sign (env: Env, p: Pending): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(p)))
  return `${body}.${b64url(await keyedHash(await serverKey(env), `google-state:${body}`))}`
}

async function unsign (env: Env, cookie: string | null, now: number): Promise<Pending | null> {
  const value = cookie?.split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  const [body, mac] = value?.split('.') ?? []
  if (!body || !mac) return null
  const want = await keyedHash(await serverKey(env), `google-state:${body}`)
  const got = fromB64url(mac)
  if (!got || !timingSafeEqual(got, want)) return null
  const p = JSON.parse(new TextDecoder().decode(fromB64url(body)!)) as Pending
  return p.exp > now ? p : null
}

/** Where the browser goes when it's done: the site page it came from, or the app on this computer. */
const landing = (env: Env, p: Pending | null) => p?.to === 'app'
  ? `http://127.0.0.1:${p.port}/auth/google`
  : `${site(env)}${p?.back ?? '/account'}`

function goTo (url: string, fragment: Record<string, string>): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url}#${new URLSearchParams(fragment)}`,
      'set-cookie': `${COOKIE}=; Max-Age=0; Path=/v1/auth/google; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

/** 1. "Continue with Google": off to Google. */
export async function googleStart (ctx: Ctx): Promise<Response> {
  const { env, url, now } = ctx
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'google_unavailable', 'Signing in with Google isn’t set up yet.')
  const q = url.searchParams
  const to = q.get('to')
  if (to !== 'site' && to !== 'app') throw bad('to: must be site or app')
  const challenge = q.get('challenge') ?? ''
  if (!B64.test(challenge)) throw bad('challenge: must be the SHA-256 of a secret, in base64url')
  const pending: Pending = { s: random(), v: random(), to, c: challenge, exp: now + COOKIE_TTL_S * 1000 }
  if (to === 'app') {
    const port = Number(q.get('port'))
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw bad('port: must be the app’s port')
    pending.port = port
  } else {
    const back = q.get('back') ?? '/account'
    if (!SITE_PAGES.includes(back)) throw bad(`back: must be one of ${SITE_PAGES.join(', ')}`)
    pending.back = back
  }
  const google = new URL(AUTH_URL)
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/v1/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: pending.s,
    code_challenge: await s256(pending.v),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  return new Response(null, {
    status: 302,
    headers: {
      location: google.toString(),
      'set-cookie': `${COOKIE}=${await sign(env, pending)}; Max-Age=${COOKIE_TTL_S}; Path=/v1/auth/google; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  })
}

/** 2. Back from Google: find or make the account, and hand the browser a one-time ticket. */
export async function googleCallback (ctx: Ctx): Promise<Response> {
  const { env, url, now, req } = ctx
  const p = await unsign(env, req.headers.get('cookie'), now)
  const back = landing(env, p)
  if (!p || url.searchParams.get('state') !== p.s) return goTo(back, { error: 'expired' })
  const said = url.searchParams.get('error')
  if (said) return goTo(back, { error: said === 'access_denied' ? 'cancelled' : 'google_failed' })
  const code = url.searchParams.get('code')
  if (!code || !env.GOOGLE_CLIENT_ID) return goTo(back, { error: 'google_failed' })

  let claims: Record<string, unknown>
  try {
    claims = await googleOf(env, url.origin).exchange(code, p.v, `${url.origin}/v1/auth/google/callback`)
  } catch (err) {
    console.error('google sign-in: the code exchange failed', (err as Error).message)
    return goTo(back, { error: 'google_failed' })
  }
  const fromGoogle = (claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com') &&
    claims.aud === env.GOOGLE_CLIENT_ID && typeof claims.exp === 'number' && claims.exp * 1000 > now
  if (!fromGoogle) return goTo(back, { error: 'google_failed' })
  if (claims.email_verified !== true && claims.email_verified !== 'true') return goTo(back, { error: 'unverified_email' })
  let mail: string
  try { mail = email(claims.email) } catch { return goTo(back, { error: 'google_failed' }) }

  let account = await env.DB.prepare('SELECT * FROM accounts WHERE email = ?').bind(mail).first<AccountRow>()
  let created = false
  if (!account) {
    const signupKey = await sha256Hex(`s:${clientIp(req)}`)
    if (await lockedFor(env, [signupKey], now) > 0) return goTo(back, { error: 'too_many_attempts' })
    await failure(env, signupKey, SIGNUP_THROTTLE.ipSignups, now, SIGNUP_THROTTLE.windowMs, SIGNUP_THROTTLE.lockMs).run()
    // No password: password_hash is empty, which no key ever matches (crypto.ts checkKey).
    const inserted = await env.DB.prepare(`INSERT INTO accounts (id, email, display_name, role, password_hash, created_at, password_changed_at)
                                           VALUES (?1, ?2, ?3, 'member', '', ?4, ?4) ON CONFLICT (email) DO NOTHING RETURNING *`)
      .bind(crypto.randomUUID(), mail, firstName(claims), now).first<AccountRow>()
    created = inserted !== null
    account = inserted ?? await env.DB.prepare('SELECT * FROM accounts WHERE email = ?').bind(mail).first<AccountRow>()
    if (!account) return goTo(back, { error: 'google_failed' })
  }
  if (account.disabled_at !== null) return goTo(back, { error: 'account_disabled' })

  const ticket = randomToken('nxt_')
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sign_in_tickets WHERE expires_at <= ?').bind(now),
    env.DB.prepare('INSERT INTO sign_in_tickets (ticket_hash, account_id, challenge, created, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(ticket), account.id, p.c, created ? 1 : 0, now + TICKET_TTL_MS),
  ])
  return goTo(back, { ticket })
}

/** Google's first name (or full name), cut to a display name's 40 characters; null when there's none. */
function firstName (claims: Record<string, unknown>): string | null {
  for (const v of [claims.given_name, claims.name]) {
    // eslint-disable-next-line no-control-regex
    const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40).trim() : ''
    if (s) return s
  }
  return null
}

/** 3. The ticket, with the secret its starter kept, for a session. */
export async function redeemTicket (ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req, 1024)
  onlyKeys(body, ['ticket', 'secret'])
  const ticket = str(body.ticket, 'ticket')
  const secret = str(body.secret, 'secret')
  if (!TICKET.test(ticket)) throw bad('ticket: must be the ticket from the sign-in link')
  if (!B64.test(secret)) throw bad('secret: must be the secret the sign-in started with')
  const { env, now } = ctx
  const invalid = () => new HttpError(401, 'invalid_ticket', 'That sign-in didn’t finish in time. Try again.')
  // Used up here, whatever happens next: a ticket is tried once.
  const row = await env.DB.prepare('DELETE FROM sign_in_tickets WHERE ticket_hash = ? AND expires_at > ? RETURNING account_id, challenge, created')
    .bind(await sha256Hex(ticket), now).first<{ account_id: string; challenge: string; created: number }>()
  if (!row || !timingSafeEqual(enc.encode(await s256(secret)), enc.encode(row.challenge))) throw invalid()
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(row.account_id).first<AccountRow>()
  if (!account) throw invalid()
  if (account.disabled_at !== null) throw new HttpError(403, 'account_disabled', 'This account has been disabled')
  const session = await createSession(env, account.id, now)
  return json({ ...session, account: accountJson(account), created: row.created === 1 })
}
