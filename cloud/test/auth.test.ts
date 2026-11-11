import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { THROTTLE } from '../src/auth.ts'
import { KDF_ITERATIONS } from '../src/crypto.ts'
import { bootstrapInvite } from '../src/bootstrap.ts'
import { INVITE_TTL_MS } from '../src/invites.ts'
import { accept, call, credential, deriveKey, invite, login, makeAdmin, makeMember, PASSWORD, prelogin, uniqueEmail, uniqueIp } from './helpers.ts'

afterEach(() => { vi.useRealTimers() })

/** Moves the Worker's clock (it runs in the test's isolate) without faking timers. */
function setNow (ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ms)
}

describe('bootstrap', () => {
  it('creates the first admin from a CLI-inserted invite, and is a no-op once an admin exists', async () => {
    const admin = await makeAdmin()
    expect(admin.role).toBe('admin')
    const me = await call('GET', '/v1/account', { token: admin.token })
    expect(me.status).toBe(200)
    expect(me.body.account).toMatchObject({ email: admin.email, role: 'admin', invitedBy: null, displayName: 'Owner' })

    // Without --force the SQL inserts nothing now that an admin exists.
    const { sql } = await bootstrapInvite()
    const r = await env.DB.prepare(sql).run()
    expect(r.meta.changes).toBe(0)
  })

  it('retires other unused bootstrap invites when one is used', async () => {
    const a = await bootstrapInvite({ force: true })
    const b = await bootstrapInvite({ force: true })
    await env.DB.batch([env.DB.prepare(a.sql), env.DB.prepare(b.sql)])
    expect((await accept(a.token, uniqueEmail('admin'))).status).toBe(201)
    const second = await accept(b.token, uniqueEmail('admin'))
    expect(second.status).toBe(400)
    expect(second.body.error).toBe('invalid_invite')
  })
})

describe('invites and sign-up', () => {
  it('any member can invite, and who invited whom is recorded', async () => {
    const admin = await makeAdmin()
    const alice = await makeMember(admin, 'Alice')
    expect(alice.role).toBe('member')
    const bob = await makeMember(alice, 'Bob')

    const me = await call('GET', '/v1/account', { token: bob.token })
    expect(me.body.account.invitedBy).toBe(alice.id)

    const mine = await call('GET', '/v1/invites', { token: alice.token })
    expect(mine.status).toBe(200)
    expect(mine.body.invites).toHaveLength(1)
    expect(mine.body.invites[0]).toMatchObject({ status: 'used', role: 'member', usedBy: { id: bob.id, email: bob.email, displayName: 'Bob' } })

    const all = await call('GET', '/v1/admin/accounts', { token: admin.token })
    const bobRow = all.body.accounts.find((a: { id: string }) => a.id === bob.id)
    expect(bobRow.invitedBy).toEqual({ id: alice.id, email: alice.email, displayName: 'Alice' })
  })

  it('returns a website /join?code= link, valid for 7 days', async () => {
    const admin = await makeAdmin()
    const before = Date.now()
    const inv = await invite(admin, 'for Sam')
    expect(inv.url).toBe(`https://site.test/join?code=${inv.token}`)
    expect(inv.token).toMatch(/^nxi_[A-Za-z0-9_-]{43}$/)
    expect(inv.expiresAt - before).toBeGreaterThanOrEqual(INVITE_TTL_MS)
    expect(inv.expiresAt - before).toBeLessThan(INVITE_TTL_MS + 60_000)
    // Only the hash is stored.
    const row = await env.DB.prepare('SELECT * FROM invites WHERE id = ?').bind(inv.id).first<Record<string, unknown>>()
    expect(JSON.stringify(row)).not.toContain(inv.token)
    expect(row!.note).toBe('for Sam')
  })

  it('an invite works once', async () => {
    const admin = await makeAdmin()
    const inv = await invite(admin)
    const first = await accept(inv.token, uniqueEmail())
    expect(first.status).toBe(201)
    const again = await accept(inv.token, uniqueEmail())
    expect(again.status).toBe(400)
    expect(again.body.error).toBe('invalid_invite')
  })

  it('two simultaneous sign-ups with one invite create one account', async () => {
    const admin = await makeAdmin()
    const inv = await invite(admin)
    const results = await Promise.all([0, 1, 2].map(() =>
      accept(inv.token, uniqueEmail())))
    expect(results.map(r => r.status).sort()).toEqual([201, 400, 400])
  })

  it('an invite expires after 7 days', async () => {
    const admin = await makeAdmin()
    const start = Date.now()
    setNow(start)
    const early = await invite(admin)
    const late = await invite(admin)
    setNow(start + INVITE_TTL_MS - 60_000)
    expect((await accept(early.token, uniqueEmail())).status).toBe(201)
    setNow(start + INVITE_TTL_MS + 1)
    const expired = await accept(late.token, uniqueEmail())
    expect(expired.status).toBe(400)
    expect(expired.body.error).toBe('invalid_invite')
    const mine = await call('GET', '/v1/invites', { token: admin.token })
    expect(mine.body.invites.find((i: { id: string }) => i.id === late.id).status).toBe('expired')
  })

  it('revoking: only your own unused invites; the admin can revoke anyone’s', async () => {
    const admin = await makeAdmin()
    const alice = await makeMember(admin)
    const bob = await makeMember(admin)
    const inv = await invite(alice)
    expect((await call('DELETE', `/v1/invites/${inv.id}`, { token: bob.token })).status).toBe(404)
    expect((await call('DELETE', `/v1/invites/${inv.id}`, { token: alice.token })).status).toBe(204)
    expect((await accept(inv.token, uniqueEmail())).status).toBe(400)

    const inv2 = await invite(alice)
    expect((await call('DELETE', `/v1/admin/invites/${inv2.id}`, { token: bob.token })).status).toBe(403)
    expect((await call('DELETE', `/v1/admin/invites/${inv2.id}`, { token: admin.token })).status).toBe(204)
    const listed = await call('GET', '/v1/admin/invites', { token: admin.token })
    expect(listed.body.invites.find((i: { id: string }) => i.id === inv2.id)).toMatchObject({ status: 'revoked', createdBy: { id: alice.id } })

    const inv3 = await invite(alice)
    await accept(inv3.token, uniqueEmail())
    const used = await call('DELETE', `/v1/invites/${inv3.id}`, { token: alice.token })
    expect(used.status).toBe(409)
  })

  it('a group link lets in up to maxUses people, then closes', async () => {
    const admin = await makeAdmin()
    const r = await call('POST', '/v1/invites', { token: admin.token, body: { maxUses: 3 } })
    expect(r.status).toBe(201)
    expect(r.body.invite).toMatchObject({ maxUses: 3, uses: 0, joined: [], status: 'pending' })
    const token = r.body.token
    const emails = [uniqueEmail(), uniqueEmail(), uniqueEmail()]
    expect((await accept(token, emails[0], PASSWORD, { displayName: 'Ann' })).status).toBe(201)
    let mine = await call('GET', '/v1/invites', { token: admin.token })
    expect(mine.body.invites.find((i: { id: string }) => i.id === r.body.invite.id)).toMatchObject({ status: 'pending', uses: 1, usedAt: null })
    expect((await accept(token, emails[1])).status).toBe(201)
    expect((await accept(token, emails[2])).status).toBe(201)
    const full = await accept(token, uniqueEmail())
    expect(full.status).toBe(400)
    expect(full.body.error).toBe('invalid_invite')

    mine = await call('GET', '/v1/invites', { token: admin.token })
    const inv = mine.body.invites.find((i: { id: string }) => i.id === r.body.invite.id)
    expect(inv).toMatchObject({ status: 'used', uses: 3, maxUses: 3, usedBy: { email: emails[0], displayName: 'Ann' } })
    expect(inv.usedAt).not.toBeNull()
    expect(inv.joined.map((p: { email: string }) => p.email)).toEqual(emails)
    // Everyone who joined is recorded as invited by the link's maker.
    const accounts = await call('GET', '/v1/admin/accounts', { token: admin.token })
    for (const e of emails) expect(accounts.body.accounts.find((a: { email: string }) => a.email === e).invitedBy.id).toBe(admin.id)
    const adminList = await call('GET', '/v1/admin/invites', { token: admin.token })
    expect(adminList.body.invites.find((i: { id: string }) => i.id === inv.id).joined).toHaveLength(3)
  })

  it('simultaneous sign-ups never overfill a group link', async () => {
    const admin = await makeAdmin()
    const r = await call('POST', '/v1/invites', { token: admin.token, body: { maxUses: 2 } })
    const results = await Promise.all([0, 1, 2, 3].map(() => accept(r.body.token, uniqueEmail())))
    expect(results.map(x => x.status).sort()).toEqual([201, 201, 400, 400])
  })

  it('a group link with places left can be stopped; members can make links for up to 10', async () => {
    const admin = await makeAdmin()
    const alice = await makeMember(admin)
    const big = await call('POST', '/v1/invites', { token: alice.token, body: { maxUses: 11 } })
    expect(big.status).toBe(400)
    const r = await call('POST', '/v1/invites', { token: alice.token, body: { maxUses: 10, note: 'film club' } })
    expect(r.status).toBe(201)
    expect((await accept(r.body.token, uniqueEmail())).status).toBe(201)
    expect((await call('DELETE', `/v1/invites/${r.body.invite.id}`, { token: alice.token })).status).toBe(204)
    expect((await accept(r.body.token, uniqueEmail())).status).toBe(400)
    const mine = await call('GET', '/v1/invites', { token: alice.token })
    expect(mine.body.invites.find((i: { id: string }) => i.id === r.body.invite.id)).toMatchObject({ status: 'revoked', uses: 1, maxUses: 10 })
    expect((await call('POST', '/v1/invites', { token: admin.token, body: { maxUses: 50 } })).status).toBe(201)
    expect((await call('POST', '/v1/invites', { token: admin.token, body: { maxUses: 51 } })).status).toBe(400)
    expect((await call('POST', '/v1/invites', { token: admin.token, body: { maxUses: 0 } })).status).toBe(400)
  })

  it('a one-person invite reports one place', async () => {
    const admin = await makeAdmin()
    const inv = await invite(admin)
    await accept(inv.token, uniqueEmail())
    const mine = await call('GET', '/v1/invites', { token: admin.token })
    expect(mine.body.invites.find((i: { id: string }) => i.id === inv.id)).toMatchObject({ status: 'used', maxUses: 1, uses: 1 })
  })

  it('limits unused invites per member', async () => {
    const admin = await makeAdmin()
    const alice = await makeMember(admin)
    for (let i = 0; i < 10; i++) await invite(alice)
    const r = await call('POST', '/v1/invites', { token: alice.token })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('too_many_invites')
  })

  it('validates sign-up input', async () => {
    const admin = await makeAdmin()
    const inv = await invite(admin)
    const signUp = (extra: Record<string, unknown>) => accept(inv.token, uniqueEmail(), PASSWORD, extra)
    expect((await signUp({ email: 'not-an-email' })).status).toBe(400)
    expect((await signUp({ displayName: 'x'.repeat(41) })).status).toBe(400)
    expect((await signUp({ extra: 1 })).status).toBe(400)
    expect((await signUp({ token: 'nxi_nope' })).body.error).toBe('invalid_invite')
    // The raw password, a short key, a bad salt or another iteration count is refused.
    expect((await signUp({ key: PASSWORD })).status).toBe(400)
    expect((await signUp({ password: PASSWORD })).status).toBe(400)
    expect((await signUp({ key: 'A'.repeat(42) })).status).toBe(400)
    expect((await signUp({ salt: 'tooshort' })).status).toBe(400)
    expect((await signUp({ iterations: 100_000 })).status).toBe(400)
    expect((await signUp({ iterations: undefined })).status).toBe(400)
    expect((await call('POST', '/v1/invites/accept', { raw: 'email=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
    // The invite is still usable after all those rejections, and emails are unique (case-insensitive).
    const email = uniqueEmail()
    expect((await signUp({ email })).status).toBe(201)
    const other = await invite(admin)
    const dup = await accept(other.token, email.toUpperCase())
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('email_taken')
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
    const admin = await makeAdmin()
    const member = await makeMember(admin)
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
    const member = await makeMember(admin)
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
    const member = await makeMember(admin)
    const first = (await call('POST', `/v1/admin/accounts/${member.id}/reset-link`, { token: admin.token })).body.token
    const second = (await call('POST', `/v1/admin/accounts/${member.id}/reset-link`, { token: admin.token })).body.token
    expect((await call('POST', '/v1/auth/reset', { body: { token: first, ...await credential('reset password 123') } })).status).toBe(400)
    expect((await call('POST', '/v1/auth/reset', { body: { token: second, ...await credential('reset password 123') } })).status).toBe(204)
  })
})

describe('admin', () => {
  it('admin endpoints are admin-only', async () => {
    const admin = await makeAdmin()
    const member = await makeMember(admin)
    for (const [method, path] of [
      ['GET', '/v1/admin/accounts'],
      ['GET', '/v1/admin/invites'],
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
    expect(row).toMatchObject({ email: member.email, role: 'member', disabledAt: null, invitedBy: { id: admin.id } })
    expect(row).not.toHaveProperty('password_hash')
    expect(JSON.stringify(list.body)).not.toContain('nxk1')
  })

  it('disabling an account ends its sessions, blocks login and revokes its unused invites', async () => {
    const admin = await makeAdmin()
    const member = await makeMember(admin)
    const pending = await invite(member)
    const r = await call('POST', `/v1/admin/accounts/${member.id}/disable`, { token: admin.token })
    expect(r.status).toBe(200)
    expect(r.body.account.disabledAt).toBeTypeOf('number')
    expect((await call('GET', '/v1/account', { token: member.token })).status).toBe(401)
    const blocked = await login(member.email)
    expect(blocked.status).toBe(403)
    expect(blocked.body.error).toBe('account_disabled')
    expect((await accept(pending.token, uniqueEmail())).status).toBe(400)

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
  it('serves the join and reset pages with a strict CSP', async () => {
    for (const path of ['/join', '/reset']) {
      const r = await call('GET', path)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(r.body).toContain('<script src="/app.js">')
    }
    expect((await call('GET', '/app.js')).status).toBe(200)
    expect((await call('GET', '/nope')).status).toBe(404)
  })
})
