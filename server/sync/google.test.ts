import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db.ts'
import { SqliteTasteStore } from '../store.ts'
import { SyncService } from './service.ts'
import { emptyBatch } from './local.ts'

// Signing this computer in with Google: the app opens the browser at the cloud's Google link, and the browser
// comes back to this computer with a one-time ticket. Only a sign-in this computer started can finish here.

const ACCOUNT = '22222222-2222-4222-8222-222222222222'
const b64url = (b: Buffer) => b.toString('base64url')

/** The cloud, keeping its one rule for tickets: the secret must hash to the challenge the sign-in began with. */
function fakeCloud () {
  const calls: string[] = []
  const tickets = new Map<string, string>() // ticket → challenge
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url))
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
    if (u.pathname === '/v1/auth/ticket') {
      const { ticket, secret } = JSON.parse(String(init?.body))
      const challenge = tickets.get(ticket)
      tickets.delete(ticket)
      if (!challenge || b64url(createHash('sha256').update(secret).digest()) !== challenge) {
        return Response.json({ error: 'invalid_ticket', message: 'That sign-in didn’t finish in time. Try again.' }, { status: 401 })
      }
      return Response.json({ token: `nxs_${'b'.repeat(43)}`, expiresAt: Date.now() + 1e10, created: false, account: { id: ACCOUNT, email: 'sam@example.com', displayName: 'Sam', role: 'member', createdAt: 0 } })
    }
    if (u.pathname === '/v1/sync/push') return Response.json({ applied: {}, serverTime: Date.now() })
    if (u.pathname === '/v1/sync/pull') return Response.json({ cursor: '0', more: false, serverTime: Date.now(), ...emptyBatch() })
    if (u.pathname.startsWith('/v1/devices/')) return Response.json({ device: {} })
    return Response.json({ error: 'not_found', message: 'Not found' }, { status: 404 })
  }) as typeof fetch
  /** What Google's round trip ends with: a ticket for the challenge in the link the app opened. */
  const googleSaysYes = (link: string) => {
    const ticket = `nxt_${b64url(Buffer.from(String(Math.random()).padEnd(32, '0'))).slice(0, 43)}`
    tickets.set(ticket, new URL(link).searchParams.get('challenge')!)
    return ticket
  }
  return { calls, fetchImpl, googleSaysYes }
}

describe('signing this computer in with Google', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let cloud: ReturnType<typeof fakeCloud>
  let sync: SyncService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexttupp-google-'))
    db = openDb(':memory:')
    cloud = fakeCloud()
    sync = new SyncService({ db, store: new SqliteTasteStore(db), dataDir: dir, cloudUrl: 'https://cloud.invalid', fetch: cloud.fetchImpl })
  })

  afterEach(() => {
    sync.stop()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens the cloud’s Google link for this app, at its port, with only a hash of its secret', () => {
    const link = new URL(sync.googleLink(4545))
    expect(link.origin + link.pathname).toBe('https://cloud.invalid/v1/auth/google')
    expect(link.searchParams.get('to')).toBe('app')
    expect(link.searchParams.get('port')).toBe('4545')
    expect(link.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('finishes the sign-in it started: the account is signed in on this computer', async () => {
    const ticket = cloud.googleSaysYes(sync.googleLink(4545))
    const status = await sync.finishGoogle(ticket)
    expect(status).toMatchObject({ signedIn: true, account: { email: 'sam@example.com', displayName: 'Sam' } })
    expect(cloud.calls[0]).toBe('POST /v1/auth/ticket')
  })

  it('a ticket from a link this computer didn’t open signs it into nothing', async () => {
    const elsewhere = fakeCloud().googleSaysYes('https://cloud.invalid/v1/auth/google?challenge=' + 'x'.repeat(43))
    await expect(sync.finishGoogle(elsewhere)).rejects.toThrow()
    expect(cloud.calls).toEqual([])
    sync.googleLink(4545)
    await expect(sync.finishGoogle(elsewhere)).rejects.toThrow()
    expect(sync.status().signedIn).toBe(false)
  })

  it('each sign-in finishes once; pressing the button again starts a new one', async () => {
    const first = cloud.googleSaysYes(sync.googleLink(4545))
    await sync.finishGoogle(first)
    await expect(sync.finishGoogle(cloud.googleSaysYes('https://cloud.invalid/?challenge=' + 'y'.repeat(43)))).rejects.toThrow()
    const second = cloud.googleSaysYes(sync.googleLink(4545))
    await expect(sync.finishGoogle(second)).resolves.toMatchObject({ signedIn: true })
  })
})
