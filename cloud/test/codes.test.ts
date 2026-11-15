import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'
import type { Mail } from '../src/http.ts'
import { BASE, call, makeMember, signup, uniqueEmail, uniqueIp } from './helpers.ts'

// Signing in with a code sent by email: type an email, get a 6-digit code, type it in. The same for a new
// account and an existing one, so there's no password to forget.

afterEach(() => { vi.useRealTimers() })

/** A stand-in for Cloudflare Email Service: keeps what would have been sent. */
function mailbox (fail?: string) {
  const sent: Mail[] = []
  return {
    sent,
    EMAIL: {
      async send (m: Mail) {
        if (fail) throw Object.assign(new Error('refused'), { code: fail })
        sent.push(m)
        return { messageId: `m${sent.length}` }
      },
    },
  }
}

type Box = ReturnType<typeof mailbox>

async function api (box: Box, method: string, path: string, body?: unknown, ip = '192.0.2.10') {
  const req = new Request(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await worker.fetch(req, { ...env, EMAIL: box.EMAIL })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const sendCode = (box: Box, email: string, ip?: string) => api(box, 'POST', '/v1/auth/code', { email }, ip)
const verify = (box: Box, email: string, code: string, extra: Record<string, unknown> = {}, ip?: string) =>
  api(box, 'POST', '/v1/auth/code/verify', { email, code, ...extra }, ip)
const codeIn = (m: Mail) => /\b(\d{6})\b/.exec(m.subject)![1]
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0')

describe('signing in with a code by email', () => {
  it('a new email gets a code, and the code creates the account and signs in', async () => {
    const box = mailbox()
    const email = uniqueEmail('new')
    const r = await sendCode(box, email.toUpperCase())
    expect(r.status).toBe(200)
    expect(box.sent).toHaveLength(1)
    const m = box.sent[0]
    expect(m.to).toBe(email)
    expect(m.from).toEqual({ email: 'sign-in@nexttupp.com', name: 'nexttupp' })
    expect(m.text).toContain(codeIn(m))

    const v = await verify(box, email, codeIn(m), { displayName: 'Sam' })
    expect(v.status).toBe(200)
    expect(v.body).toMatchObject({ created: true, account: { email, displayName: 'Sam', role: 'member' } })
    expect((await call('GET', '/v1/account', { token: v.body.token })).body.account.email).toBe(email)
  })

  it('an existing account signs in with a code and keeps everything (it isn’t a new account)', async () => {
    const box = mailbox()
    const friend = await makeMember()
    await sendCode(box, friend.email)
    const v = await verify(box, friend.email, codeIn(box.sent[0]))
    expect(v.status).toBe(200)
    expect(v.body).toMatchObject({ created: false, account: { id: friend.id, email: friend.email } })
  })

  it('says the same whether or not the email has an account', async () => {
    const box = mailbox()
    const friend = await makeMember()
    const known = await sendCode(box, friend.email)
    const unknown = await sendCode(box, uniqueEmail('nobody'))
    expect(Object.keys(known.body)).toEqual(Object.keys(unknown.body))
    expect(known.status).toBe(unknown.status)
  })

  it('a code works once', async () => {
    const box = mailbox()
    const email = uniqueEmail()
    await sendCode(box, email)
    const code = codeIn(box.sent[0])
    expect((await verify(box, email, code)).status).toBe(200)
    expect((await verify(box, email, code)).body.error).toBe('invalid_code')
  })

  it('five wrong tries and the code stops working, even the right one', async () => {
    const box = mailbox()
    const email = uniqueEmail()
    await sendCode(box, email)
    const code = codeIn(box.sent[0])
    const first = await verify(box, email, wrong(code))
    expect(first.status).toBe(401)
    expect(first.body.message).toMatch(/4 tries left/)
    for (let i = 0; i < 4; i++) await verify(box, email, wrong(code))
    const after = await verify(box, email, code)
    expect(after.status).toBe(401)
    expect(after.body.message).toMatch(/new code/i)
  })

  it('a code lasts 10 minutes', async () => {
    const box = mailbox()
    const email = uniqueEmail()
    await sendCode(box, email)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60_000)
    expect((await verify(box, email, codeIn(box.sent[0]))).body.error).toBe('invalid_code')
  })

  it('asking again replaces the code: only the newest works', async () => {
    const box = mailbox()
    const email = uniqueEmail()
    await sendCode(box, email)
    await sendCode(box, email)
    const [older, newer] = box.sent.map(codeIn)
    if (older !== newer) expect((await verify(box, email, older)).status).toBe(401)
    expect((await verify(box, email, newer)).status).toBe(200)
  })

  it('an email gets at most 5 codes an hour, so nobody can flood someone’s inbox', async () => {
    const box = mailbox()
    const email = uniqueEmail()
    for (let i = 0; i < 5; i++) expect((await sendCode(box, email, uniqueIp())).status).toBe(200)
    const sixth = await sendCode(box, email, uniqueIp())
    expect(sixth.status).toBe(429)
    expect(box.sent).toHaveLength(5)
  })

  it('keeps no email address for people who never finish signing up', async () => {
    const box = mailbox()
    const email = uniqueEmail('passing')
    await sendCode(box, email)
    const rows = await env.DB.prepare('SELECT * FROM email_codes').all()
    expect(JSON.stringify(rows.results)).not.toContain(email)
    expect(JSON.stringify(rows.results)).not.toContain(codeIn(box.sent[0]))
  })

  it('when email can’t be sent, says so plainly', async () => {
    const r = await sendCode(mailbox('E_DAILY_LIMIT_EXCEEDED'), uniqueEmail())
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('email_unavailable')
  })

  it('a disabled account can’t sign in with a code', async () => {
    const box = mailbox()
    const email = uniqueEmail()
    const s = await signup(email)
    await env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').bind(Date.now(), s.body.account.id).run()
    await sendCode(box, email)
    expect((await verify(box, email, codeIn(box.sent[0]))).status).toBe(403)
  })
})
