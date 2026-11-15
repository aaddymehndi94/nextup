import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'
import { b64url } from '../src/crypto.ts'
import { BASE, call, makeMember, uniqueEmail, uniqueIp } from './helpers.ts'

// "Continue with Google": the site or the app sends the browser here, Google sends it back, and the account
// with that Google email signs in (or is made). The browser comes back with a one-time ticket that only the
// page or app that started can turn into a session, with a secret it kept.

afterEach(() => { vi.useRealTimers() })

const CLIENT = 'test-client.apps.googleusercontent.com'
const SITE = 'https://nexttupp.com'

interface Asked { code: string; verifier: string; redirectUri: string }

/** A stand-in for Google's token endpoint: answers with these ID-token claims and keeps what it was asked. */
function google (claims: Record<string, unknown> | ((email: string) => Record<string, unknown>) = {}) {
  const asked: Asked[] = []
  return {
    asked,
    adapter: {
      async exchange (code: string, verifier: string, redirectUri: string) {
        asked.push({ code, verifier, redirectUri })
        const base = { iss: 'https://accounts.google.com', aud: CLIENT, sub: '1067', email_verified: true, given_name: 'Sam', name: 'Sam Rivera', exp: Math.floor(Date.now() / 1000) + 3600 }
        return { ...base, ...(typeof claims === 'function' ? claims(code) : claims) }
      },
    },
  }
}
type Google = ReturnType<typeof google>

const envWith = (g: Google, extra: Record<string, unknown> = {}) => ({ ...env, GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'shh', GOOGLE: g.adapter, ...extra })

async function get (g: Google, path: string, cookie?: string, extra?: Record<string, unknown>, base = BASE) {
  const headers: Record<string, string> = { 'cf-connecting-ip': uniqueIp() } // each its own network: new accounts are limited per network
  if (cookie) headers.cookie = cookie
  return worker.fetch(new Request(base + path, { headers, redirect: 'manual' }), envWith(g, extra) as never)
}

async function secretPair () {
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
  return { secret, challenge }
}

/** Presses "Continue with Google", lets Google send the browser back with `code`, and returns where it lands. */
async function roundTrip (g: Google, opts: { to?: string; port?: number; back?: string; code?: string; challenge: string; tamper?: (state: string) => string; googleSays?: string }) {
  const q = new URLSearchParams({ to: opts.to ?? 'site', challenge: opts.challenge })
  if (opts.port) q.set('port', String(opts.port))
  if (opts.back) q.set('back', opts.back)
  const start = await get(g, `/v1/auth/google?${q}`)
  expect(start.status).toBe(302)
  const toGoogle = new URL(start.headers.get('location')!)
  const cookie = start.headers.get('set-cookie')!.split(';')[0]
  const state = toGoogle.searchParams.get('state')!
  const back = new URLSearchParams(opts.googleSays ? { error: opts.googleSays, state } : { code: opts.code ?? 'google-code', state: opts.tamper ? opts.tamper(state) : state })
  const done = await get(g, `/v1/auth/google/callback?${back}`, cookie)
  expect(done.status).toBe(302)
  const landing = new URL(done.headers.get('location')!)
  const hash = new URLSearchParams(landing.hash.slice(1))
  return { toGoogle, start, landing, ticket: hash.get('ticket'), error: hash.get('error') }
}

const redeem = (ticket: string, secret: string) => call('POST', '/v1/auth/ticket', { body: { ticket, secret }, ip: uniqueIp() })

describe('Continue with Google', () => {
  it('sends the browser to Google with this server’s callback, PKCE and a state, remembered in a short-lived cookie', async () => {
    const g = google()
    const { challenge } = await secretPair()
    const res = await get(g, `/v1/auth/google?to=site&challenge=${challenge}`)
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location')!)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT)
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/v1/auth/google/callback`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=600/i)
  })

  it('makes a new account from the Google email and first name, and signs in', async () => {
    const mail = uniqueEmail('new')
    const g = google({ email: mail.toUpperCase() })
    const { secret, challenge } = await secretPair()
    const r = await roundTrip(g, { challenge })
    expect(r.landing.origin + r.landing.pathname).toBe(`${SITE}/account`)
    const s = await redeem(r.ticket!, secret)
    expect(s.status).toBe(200)
    expect(s.body.created).toBe(true)
    expect(s.body.account).toMatchObject({ email: mail, displayName: 'Sam' })
    expect((await call('GET', '/v1/account', { token: s.body.token })).body.account.email).toBe(mail)
  })

  it('signs into the account that already has that email, so its profiles, likes and lists are all still there', async () => {
    const member = await makeMember('Friend')
    const g = google({ email: member.email })
    const { secret, challenge } = await secretPair()
    const s = await redeem((await roundTrip(g, { challenge })).ticket!, secret)
    expect(s.status).toBe(200)
    expect(s.body.created).toBe(false)
    expect(s.body.account).toMatchObject({ id: member.id, email: member.email, displayName: 'Friend' })
  })

  it('uses PKCE: Google is asked with the verifier whose hash went out in the link', async () => {
    const g = google({ email: uniqueEmail() })
    const r = await roundTrip(g, { challenge: (await secretPair()).challenge, code: 'the-code' })
    const sent = r.toGoogle.searchParams.get('code_challenge')
    const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(g.asked[0].verifier))))
    expect(g.asked[0]).toMatchObject({ code: 'the-code', redirectUri: `${BASE}/v1/auth/google/callback` })
    expect(hash).toBe(sent)
  })

  it('hands the desktop app its ticket on this computer, at the port the app gave', async () => {
    const r = await roundTrip(google({ email: uniqueEmail() }), { to: 'app', port: 4545, challenge: (await secretPair()).challenge })
    expect(r.landing.href.startsWith('http://127.0.0.1:4545/auth/google#ticket=nxt_')).toBe(true)
  })

  it('goes back to the page it came from on the site, of the ones that sign in', async () => {
    const r = await roundTrip(google({ email: uniqueEmail() }), { back: '/watch', challenge: (await secretPair()).challenge })
    expect(r.landing.origin + r.landing.pathname).toBe(`${SITE}/watch`)
    const bad = await get(google(), `/v1/auth/google?to=site&back=${encodeURIComponent('https://evil.example/')}&challenge=${(await secretPair()).challenge}`)
    expect(bad.status).toBe(400)
  })

  it('a ticket needs the secret of whoever started, and works once', async () => {
    const { secret, challenge } = await secretPair()
    const { ticket } = await roundTrip(google({ email: uniqueEmail() }), { challenge })
    expect((await redeem(ticket!, (await secretPair()).secret)).status).toBe(401)
    expect((await redeem(ticket!, secret)).status).toBe(401) // the wrong try used it up
    const again = await secretPair()
    const t2 = (await roundTrip(google({ email: uniqueEmail() }), { challenge: again.challenge })).ticket!
    expect((await redeem(t2, again.secret)).status).toBe(200)
    expect((await redeem(t2, again.secret)).status).toBe(401)
  })

  it('a ticket lasts two minutes', async () => {
    const { secret, challenge } = await secretPair()
    const { ticket } = await roundTrip(google({ email: uniqueEmail() }), { challenge })
    vi.useFakeTimers({ now: Date.now() + 121_000, toFake: ['Date'] })
    expect((await redeem(ticket!, secret)).status).toBe(401)
  })

  it('a callback that this browser didn’t start signs no one in', async () => {
    const g = google({ email: uniqueEmail() })
    const r = await roundTrip(g, { challenge: (await secretPair()).challenge, tamper: s => s.slice(0, -2) + 'xx' })
    expect(r.ticket).toBeNull()
    expect(r.error).toBe('expired')
    expect(g.asked).toEqual([])
    const noCookie = await get(g, '/v1/auth/google/callback?code=c&state=whatever')
    expect(new URL(noCookie.headers.get('location')!).hash).toBe('#error=expired')
  })

  it('turns away an email Google hasn’t verified, and a token meant for another app', async () => {
    const unverified = await roundTrip(google({ email: uniqueEmail(), email_verified: false }), { challenge: (await secretPair()).challenge })
    expect(unverified).toMatchObject({ ticket: null, error: 'unverified_email' })
    const other = await roundTrip(google({ email: uniqueEmail(), aud: 'someone-else' }), { challenge: (await secretPair()).challenge })
    expect(other).toMatchObject({ ticket: null, error: 'google_failed' })
  })

  it('someone who cancels at Google comes back to where they started, with nothing changed', async () => {
    const g = google()
    const r = await roundTrip(g, { to: 'app', port: 4545, challenge: (await secretPair()).challenge, googleSays: 'access_denied' })
    expect(r.landing.href).toBe('http://127.0.0.1:4545/auth/google#error=cancelled')
    expect(g.asked).toEqual([])
  })

  it('a disabled account stays out', async () => {
    const member = await makeMember()
    await env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').bind(Date.now(), member.id).run()
    const r = await roundTrip(google({ email: member.email }), { challenge: (await secretPair()).challenge })
    expect(r).toMatchObject({ ticket: null, error: 'account_disabled' })
  })

  it('a local test cloud can stand in for Google (the code is the email), only on localhost and only when asked', async () => {
    const dev = { GOOGLE: undefined, DEV_FAKE_GOOGLE: 'on' }
    const mail = uniqueEmail('dev')
    const pass = async (base: string) => {
      const { secret, challenge } = await secretPair()
      const start = await get(google(), `/v1/auth/google?to=site&challenge=${challenge}`, undefined, dev, base)
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!
      const cookie = start.headers.get('set-cookie')!.split(';')[0]
      const back = await get(google(), `/v1/auth/google/callback?${new URLSearchParams({ code: `${mail}|Dev`, state })}`, cookie, dev, base)
      return { hash: new URLSearchParams(new URL(back.headers.get('location')!).hash.slice(1)), secret }
    }
    const local = await pass('http://localhost:8799')
    const s = await redeem(local.hash.get('ticket')!, local.secret)
    expect(s.body.account).toMatchObject({ email: mail, displayName: 'Dev' })
    expect((await pass(BASE)).hash.get('error')).toBe('google_failed') // a real host never takes the stand-in
  })

  it('says so when Google sign-in isn’t set up, and checks what it’s given', async () => {
    const { challenge } = await secretPair()
    expect((await get(google(), `/v1/auth/google?to=site&challenge=${challenge}`, undefined, { GOOGLE_CLIENT_ID: undefined })).status).toBe(503)
    expect((await get(google(), '/v1/auth/google?to=site')).status).toBe(400)
    expect((await get(google(), `/v1/auth/google?to=app&port=80&challenge=${challenge}`)).status).toBe(400)
    expect((await get(google(), `/v1/auth/google?to=elsewhere&challenge=${challenge}`)).status).toBe(400)
  })
})
