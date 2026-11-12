import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGNUP_THROTTLE, THROTTLE } from '../src/auth.ts'
import { KDF_ITERATIONS } from '../src/crypto.ts'
import { call, credential, deriveKey, login, makeAdmin, makeMember, PASSWORD, prelogin, signup, uniqueEmail, uniqueIp } from './helpers.ts'

afterEach(() => { vi.useRealTimers() })

/** Moves the Worker's clock (it runs in the test's isolate) without faking timers. */
function setNow (ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ms)
}

describe('sign-up', () => {
  it('anyone can sign up, without an invite, and gets a member account', async () => {
    const email = uniqueEmail('new')
    const r = await signup(email, PASSWORD, { displayName: '  Sam ' })
    expect(r.status).toBe(201)
    expect(r.body.account).toMatchObject({ email, role: 'member', displayName: 'Sam' })
    expect(r.body.account).not.toHaveProperty('invitedBy')
    const signedIn = await login(email)
    expect(signedIn.status).toBe(200)
    const me = await call('GET', '/v1/account', { token: signedIn.body.token })
    expect(me.body.account).toMatchObject({ email, role: 'member' })
  })

  it('a role in the body is refused, so no one signs up as an admin', async () => {
    const r = await signup(uniqueEmail(), PASSWORD, { role: 'admin' })
    expect(r.status).toBe(400)
  })

  it('validates sign-up input', async () => {
    const ip = uniqueIp()
    const up = (extra: Record<string, unknown>) => signup(uniqueEmail(), PASSWORD, extra, uniqueIp())
    expect((await up({ email: 'not-an-email' })).status).toBe(400)
    expect((await up({ displayName: 'x'.repeat(41) })).status).toBe(400)
    expect((await up({ extra: 1 })).status).toBe(400)
    expect((await up({ token: 'nxi_old_invite_code' })).status).toBe(400)
    // The raw password, a short key, a bad salt or another iteration count is refused.
    expect((await up({ key: PASSWORD })).status).toBe(400)
    expect((await up({ password: PASSWORD })).status).toBe(400)
    expect((await up({ key: 'A'.repeat(42) })).status).toBe(400)
    expect((await up({ salt: 'tooshort' })).status).toBe(400)
    expect((await up({ iterations: 100_000 })).status).toBe(400)
    expect((await up({ iterations: undefined })).status).toBe(400)
    expect((await call('POST', '/v1/auth/signup', { raw: 'email=x', headers: { 'content-type': 'application/x-www-form-urlencoded' }, ip })).status).toBe(415)
    // Emails are unique, case-insensitively.
    const email = uniqueEmail()
    expect((await signup(email)).status).toBe(201)
    const dup = await signup(email.toUpperCase())
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('email_taken')
  })

  it('two simultaneous sign-ups with one email create one account', async () => {
    const email = uniqueEmail()
    const results = await Promise.all([signup(email), signup(email)])
    expect(results.map(r => r.status).sort()).toEqual([201, 409])
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE email = ?').bind(email).first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it(`allows ${SIGNUP_THROTTLE.ipSignups} sign-ups per network an hour, then waits`, async () => {
    const start = Date.now()
    setNow(start)
    const ip = uniqueIp()
    for (let i = 0; i < SIGNUP_THROTTLE.ipSignups; i++) expect((await signup(uniqueEmail(), PASSWORD, {}, ip)).status).toBe(201)
    const blocked = await signup(uniqueEmail(), PASSWORD, {}, ip)
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toBe('too_many_attempts')
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await signup(uniqueEmail(), PASSWORD, {}, uniqueIp())).status).toBe(201)
    setNow(start + SIGNUP_THROTTLE.lockMs + 1000)
    expect((await signup(uniqueEmail(), PASSWORD, {}, ip)).status).toBe(201)
  })

  it('the old invite endpoints are gone', async () => {
    const admin = await makeAdmin()
    expect((await call('POST', '/v1/invites', { token: admin.token })).status).toBe(404)
    expect((await call('POST', '/v1/invites/accept', { body: {} })).status).toBe(404)
    expect((await call('GET', '/v1/admin/invites', { token: admin.token })).status).toBe(404)
  })
})

describe('login, sessions, logout', () => {
  it('logs in with email and password and returns an opaque bearer token', async () => {
    const admin = await makeAdmin()
    const r = await login(admin.email.toUpperCase())
    expect(r.status).toBe(200)
    expect(r.body.token).toMatch(/^nxs_[A-Za-z0-9_-]{43}$/)
    expect(r.body.account.email).toBe(admin.email)
    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(r.body.token).first<{ n: number }>()
    expect(stored!.n).toBe(0) // stored hashed, never as the token
  })

  it('wrong password and unknown email fail the same way', async () => {
    const admin = await makeAdmin()
    const wrong = await login(admin.email, 'wrong password!')
    const unknown = await login(uniqueEmail('nobody'), 'wrong password!')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body).toEqual(unknown.body)
  })

  it('rejects missing, malformed and unknown tokens', async () => {
    expect((await call('GET', '/v1/account')).status).toBe(401)
    expect((await call('GET', '/v1/account', { token: 'garbage' })).status).toBe(401)
    expect((await call('GET', '/v1/account', { token: `nxs_${'A'.repeat(43)}` })).status).toBe(401)
  })

  it('logout ends this session only; logout {all:true} ends every session', async () => {
    const admin = await makeAdmin()
    const a = (await login(admin.email)).body.token
    const b = (await login(admin.email)).body.token
    expect((await call('POST', '/v1/auth/logout', { token: a })).status).toBe(204)
    expect((await call('GET', '/v1/account', { token: a })).status).toBe(401)
    expect((await call('GET', '/v1/account', { token: b })).status).toBe(200)
    const c = (await login(admin.email)).body.token
    expect((await call('POST', '/v1/auth/logout', { token: c, body: { all: true } })).status).toBe(204)
    expect((await call('GET', '/v1/account', { token: b })).status).toBe(401)
    expect((await call('GET', '/v1/account', { token: admin.token })).status).toBe(401)
  })

  it('sessions expire after 90 idle days, and use extends them', async () => {
    const admin = await makeAdmin()
    const start = Date.now()
    setNow(start)
    const token = (await login(admin.email)).body.token
    setNow(start + 60 * 86_400_000)
    expect((await call('GET', '/v1/account', { token })).status).toBe(200) // extends to day 150
    setNow(start + 140 * 86_400_000)
    expect((await call('GET', '/v1/account', { token })).status).toBe(200)
    setNow(start + 231 * 86_400_000)
    expect((await call('GET', '/v1/account', { token })).status).toBe(401)
  })

  it('updates the display name', async () => {
    const admin = await makeAdmin()
    const r = await call('PATCH', '/v1/account', { token: admin.token, body: { displayName: '  New   Name ' } })
    expect(r.status).toBe(200)
    expect(r.body.account.displayName).toBe('New Name')
  })
})

describe('client-side key stretching', () => {
  it('prelogin returns the salt the account signed up with', async () => {
    const admin = await makeAdmin()
    const row = await env.DB.prepare('SELECT password_hash FROM accounts WHERE id = ?').bind(admin.id).first<{ password_hash: string }>()
    const r = await prelogin(admin.email.toUpperCase())
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ kdf: 'pbkdf2-sha256', iterations: KDF_ITERATIONS, salt: row!.password_hash.split('$')[2] })
  })

  it('prelogin gives an unknown email a stable fake salt that looks like a real one', async () => {
    const admin = await makeAdmin()
    const nobody = uniqueEmail('nobody')
    const a = await prelogin(nobody)
    const b = await prelogin(nobody)
    const other = await prelogin(uniqueEmail('nobody'))
    const real = await prelogin(admin.email)
    expect(a.status).toBe(200)
    expect(a.body).toEqual(b.body)
    expect(other.body.salt).not.toBe(a.body.salt)
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(real.body).sort())
    expect(a.body.iterations).toBe(real.body.iterations)
    expect(a.body.salt).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(real.body.salt).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('stores only an HMAC of the key, never the key or the password', async () => {
    const admin = await makeAdmin()
    const salt = (await prelogin(admin.email)).body.salt
    const key = await deriveKey(PASSWORD, salt)
    const row = await env.DB.prepare('SELECT password_hash FROM accounts WHERE id = ?').bind(admin.id).first<{ password_hash: string }>()
    expect(row!.password_hash).toMatch(/^nxk1\$600000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    expect(row!.password_hash).not.toContain(key)
    expect(row!.password_hash).not.toContain(PASSWORD)
  })

  it('login takes only the derived key: a raw password or a malformed key is a 400, not a guess', async () => {
    const admin = await makeAdmin()
    const ip = uniqueIp()
    for (const key of [PASSWORD, 'A'.repeat(42), 'A'.repeat(44), '']) {
      const r = await call('POST', '/v1/auth/login', { body: { email: admin.email, key }, ip })
      expect(r.status, JSON.stringify(key)).toBe(400)
    }
    expect((await call('POST', '/v1/auth/login', { body: { email: admin.email, password: PASSWORD }, ip })).status).toBe(400)
    // A key derived with the wrong salt is just a wrong password.
    const wrongSalt = await call('POST', '/v1/auth/login', { body: { email: admin.email, key: await deriveKey(PASSWORD, 'AAAAAAAAAAAAAAAAAAAAAA') }, ip })
    expect(wrongSalt.status).toBe(401)
    expect((await login(admin.email, PASSWORD, ip)).status).toBe(200)
  })
})

describe('brute-force protection', () => {
  it(`locks an email after ${THROTTLE.emailFailures} failures, even for the right password, until the lock ends`, async () => {
    const admin = await makeAdmin()
    const start = Date.now()
    setNow(start)
    for (let i = 0; i < THROTTLE.emailFailures; i++) expect((await login(admin.email, 'nope nope nope')).status).toBe(401)
    const locked = await login(admin.email)
    expect(locked.status).toBe(429)
    expect(locked.body.error).toBe('too_many_attempts')
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
    setNow(start + THROTTLE.lockMs + 1000)
    expect((await login(admin.email)).status).toBe(200)
  })

  it(`locks an IP after ${THROTTLE.ipFailures} failures across emails`, async () => {
    const admin = await makeAdmin()
    const ip = uniqueIp()
    for (let i = 0; i < THROTTLE.ipFailures; i++) expect((await login(uniqueEmail('spray'), 'nope nope nope', ip)).status).toBe(401)
    expect((await login(admin.email, PASSWORD, ip)).status).toBe(429)
    expect((await login(admin.email, PASSWORD, uniqueIp())).status).toBe(200)
  })

  it('stores no emails or IPs in the throttle table', async () => {
    const email = uniqueEmail('throttle')
    await login(email, 'nope nope nope', '203.0.113.77')
    const rows = await env.DB.prepare('SELECT key FROM login_attempts').all<{ key: string }>()
    for (const r of rows.results) {
      expect(r.key).toMatch(/^[0-9a-f]{64}$/)
      expect(r.key).not.toContain('203.0.113.77')
    }
  })
})

describe('passwords', () => {
  it('changing the password needs the current one and signs out other sessions', async () => {
    const member = await makeMember()
    const other = (await login(member.email)).body.token
    const salt = (await prelogin(member.email)).body.salt
    const change = async (current: string) => call('POST', '/v1/account/password', {
      token: member.token, body: { currentKey: await deriveKey(current, salt), ...await credential('a brand new password') },
    })
    const wrong = await change('not it at all')
    expect(wrong.status).toBe(403)
    const ok = await change(PASSWORD)
    expect(ok.status).toBe(204)
    expect((await call('GET', '/v1/account', { token: member.token })).status).toBe(200)
    expect((await call('GET', '/v1/account', { token: other })).status).toBe(401)
    expect((await login(member.email)).status).toBe(401)
    expect((await login(member.email, 'a brand new password')).status).toBe(200)
  })

  it('an admin-issued reset link sets a new password once and signs out every session', async () => {
    const admin = await makeAdmin()
    const member = await makeMember()
    expect((await call('POST', `/v1/admin/accounts/${member.id}/reset-link`, { token: member.token })).status).toBe(403)
    const link = await call('POST', `/v1/admin/accounts/${member.id}/reset-link`, { token: admin.token })
    expect(link.status).toBe(201)
    expect(link.body.url).toBe(`https://cloud.test/reset#${link.body.token}`)
    const reset = await call('POST', '/v1/auth/reset', { body: { token: link.body.token, ...await credential('reset password 123') } })
    expect(reset.status).toBe(204)
    expect((await call('GET', '/v1/account', { token: member.token })).status).toBe(401)
    expect((await login(member.email, 'reset password 123')).status).toBe(200)
    const reuse = await call('POST', '/v1/auth/reset', { body: { token: link.body.token, ...await credential('another password 456') } })
    expect(reuse.status).toBe(400)
    expect(reuse.body.error).toBe('invalid_token')
  })

  it('a newer reset link replaces an older unused one', async () => {
    const admin = await makeAdmin()
    const member = await makeMember()
    const first = (await call('POST', `/v1/admin/accounts/${member.id}/reset-link`, { token: admin.token })).body.token
    const second = (await call('POST', `/v1/admin/accounts/${member.id}/reset-link`, { token: admin.token })).body.token
    expect((await call('POST', '/v1/auth/reset', { body: { token: first, ...await credential('reset password 123') } })).status).toBe(400)
    expect((await call('POST', '/v1/auth/reset', { body: { token: second, ...await credential('reset password 123') } })).status).toBe(204)
  })
})

describe('admin', () => {
  it('admin endpoints are admin-only', async () => {
    const admin = await makeAdmin()
    const member = await makeMember()
    for (const [method, path] of [
      ['GET', '/v1/admin/accounts'],
      ['POST', `/v1/admin/accounts/${admin.id}/disable`],
      ['POST', `/v1/admin/accounts/${admin.id}/enable`],
      ['POST', `/v1/admin/accounts/${admin.id}/reset-link`],
    ] as const) {
      expect((await call(method, path, { token: member.token })).status, `${method} ${path} as member`).toBe(403)
      expect((await call(method, path)).status, `${method} ${path} signed out`).toBe(401)
    }
    const list = await call('GET', '/v1/admin/accounts', { token: admin.token })
    expect(list.status).toBe(200)
    const row = list.body.accounts.find((a: { id: string }) => a.id === member.id)
    expect(row).toMatchObject({ email: member.email, role: 'member', disabledAt: null })
    expect(row).not.toHaveProperty('password_hash')
    expect(JSON.stringify(list.body)).not.toContain('nxk1')
  })

  it('disabling an account ends its sessions and blocks login', async () => {
    const admin = await makeAdmin()
    const member = await makeMember()
    const r = await call('POST', `/v1/admin/accounts/${member.id}/disable`, { token: admin.token })
    expect(r.status).toBe(200)
    expect(r.body.account.disabledAt).toBeTypeOf('number')
    expect((await call('GET', '/v1/account', { token: member.token })).status).toBe(401)
    const blocked = await login(member.email)
    expect(blocked.status).toBe(403)
    expect(blocked.body.error).toBe('account_disabled')

    expect((await call('POST', `/v1/admin/accounts/${member.id}/enable`, { token: admin.token })).status).toBe(200)
    expect((await login(member.email)).status).toBe(200)
  })

  it('an admin cannot disable their own account', async () => {
    const admin = await makeAdmin()
    const r = await call('POST', `/v1/admin/accounts/${admin.id}/disable`, { token: admin.token })
    expect(r.status).toBe(409)
  })
})

describe('pages', () => {
  it('serves the reset page with a strict CSP', async () => {
    const r = await call('GET', '/reset')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(r.body).toContain('<script src="/app.js">')
    expect((await call('GET', '/app.js')).status).toBe(200)
    expect((await call('GET', '/join')).status).toBe(404)
    expect((await call('GET', '/nope')).status).toBe(404)
  })
})
