import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_TTL_MS, networkKey } from '../src/devices.ts'
import { call, makeAdmin, makeMember, type User } from './helpers.ts'

afterEach(() => { vi.useRealTimers() })

const HOME = '203.0.113.7'
const ELSEWHERE = '198.51.100.20'

function laptop (over: Record<string, unknown> = {}) {
  return { name: 'Laptop (Linux)', platform: 'linux', lan: true, lanUrls: ['http://192.168.1.20:4545', 'http://10.0.0.5:4545'], ...over }
}

const register = (u: User, id: string, body: unknown = laptop(), ip = HOME) => call('PUT', `/v1/devices/${id}`, { token: u.token, body, ip })
const list = (u: User, ip = HOME) => call('GET', '/v1/devices', { token: u.token, ip })
const handoff = (u: User, id: string, ip = HOME) => call('POST', `/v1/devices/${id}/handoff`, { token: u.token, ip })
const redeem = (u: User, code: string, deviceId: string) => call('POST', '/v1/handoff/redeem', { token: u.token, body: { code, deviceId } })

describe('devices', () => {
  it('registers, refreshes and lists a computer, marking the caller’s network', async () => {
    const admin = await makeAdmin()
    const id = crypto.randomUUID()
    const r = await register(admin, id)
    expect(r.status).toBe(200)
    expect(r.body.device).toMatchObject({ id, name: 'Laptop (Linux)', platform: 'linux', lan: true, lanUrls: ['http://192.168.1.20:4545', 'http://10.0.0.5:4545'], online: true, sameNetwork: true })

    const renamed = await register(admin, id, laptop({ name: 'Den' }))
    expect(renamed.body.device.name).toBe('Den')

    const home = await list(admin)
    expect(home.status).toBe(200)
    expect(home.body.devices).toHaveLength(1)
    expect(home.body.devices[0]).toMatchObject({ id, name: 'Den', sameNetwork: true, online: true })
    expect((await list(admin, ELSEWHERE)).body.devices[0].sameNetwork).toBe(false)
  })

  it('keeps no IP address, only an HMAC', async () => {
    const admin = await makeAdmin()
    const id = crypto.randomUUID()
    await register(admin, id)
    const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<Record<string, unknown>>()
    expect(JSON.stringify(row)).not.toContain(HOME)
    expect(row!.net_hash).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('treats IPv6 addresses in one /64 as one network', async () => {
    expect(networkKey('2001:db8:1:2:aaaa::1')).toBe(networkKey('2001:0db8:0001:0002:ffff:1:2:3'))
    expect(networkKey('2001:db8:1:2::1')).not.toBe(networkKey('2001:db8:1:3::1'))
    expect(networkKey('::ffff:192.0.2.1')).toBe(networkKey('192.0.2.1'))
    expect(networkKey('unknown')).toBeNull()
    expect(networkKey('1:2::3::4')).toBeNull()

    const admin = await makeAdmin()
    const id = crypto.randomUUID()
    await register(admin, id, laptop(), '2001:db8:1:2:aaaa::1')
    expect((await list(admin, '2001:db8:1:2:bbbb:cccc:dddd:eeee')).body.devices[0].sameNetwork).toBe(true)
  })

  it('accepts only private IPv4 addresses on the home network', async () => {
    const admin = await makeAdmin()
    for (const url of ['http://8.8.8.8:4545', 'https://192.168.1.2:4545', 'http://192.168.1.2', 'http://evil.example:80', 'http://172.32.0.1:80', 'http://192.168.1.300:80', 'javascript:alert(1)']) {
      const r = await register(admin, crypto.randomUUID(), laptop({ lanUrls: [url] }))
      expect(r.status, url).toBe(400)
    }
    expect((await register(admin, crypto.randomUUID(), laptop({ lan: false }))).status).toBe(400)
    expect((await register(admin, crypto.randomUUID(), laptop({ lan: false, lanUrls: [] }))).status).toBe(200)
    expect((await register(admin, 'NOT-A-UUID', laptop())).status).toBe(400)
    expect((await register(admin, crypto.randomUUID(), laptop({ extra: 1 }))).status).toBe(400)
    expect((await register(admin, crypto.randomUUID(), laptop({ name: 'https://x.example' }))).status).toBe(400)
  })

  it('is per account: another account neither sees nor removes it', async () => {
    const admin = await makeAdmin()
    const friend = await makeMember(admin)
    const id = crypto.randomUUID()
    await register(admin, id)
    expect((await list(friend)).body.devices).toEqual([])
    expect((await call('DELETE', `/v1/devices/${id}`, { token: friend.token })).status).toBe(204)
    expect((await list(admin)).body.devices).toHaveLength(1)
    // The same id under the other account is a separate device.
    expect((await register(friend, id, laptop({ name: 'Friend’s PC' }))).status).toBe(200)
    expect((await list(admin)).body.devices[0].name).toBe('Laptop (Linux)')
  })

  it('sign-out removes the device and its pending codes', async () => {
    const admin = await makeAdmin()
    const id = crypto.randomUUID()
    await register(admin, id)
    const h = await handoff(admin, id)
    expect(h.status).toBe(201)
    expect((await call('DELETE', `/v1/devices/${id}`, { token: admin.token })).status).toBe(204)
    expect((await list(admin)).body.devices).toEqual([])
    expect((await redeem(admin, h.body.code, id)).status).toBe(400)
  })

  it('needs a session', async () => {
    expect((await call('GET', '/v1/devices')).status).toBe(401)
    expect((await call('PUT', `/v1/devices/${crypto.randomUUID()}`, { body: laptop() })).status).toBe(401)
    expect((await call('POST', '/v1/handoff/redeem', { body: { code: 'nxh_' + 'a'.repeat(43), deviceId: crypto.randomUUID() } })).status).toBe(401)
  })
})

describe('phone handoff', () => {
  it('a code works once, for its device and account', async () => {
    const admin = await makeAdmin()
    const id = crypto.randomUUID()
    await register(admin, id)
    const h = await handoff(admin, id)
    expect(h.status).toBe(201)
    expect(h.body.code).toMatch(/^nxh_[A-Za-z0-9_-]{43}$/)
    expect(h.body.lanUrls).toEqual(['http://192.168.1.20:4545', 'http://10.0.0.5:4545'])
    expect(h.body.expiresAt - Date.now()).toBeLessThanOrEqual(HANDOFF_TTL_MS)

    // Only the hash is stored.
    const rows = await env.DB.prepare('SELECT * FROM handoffs WHERE device_id = ?').bind(id).all()
    expect(JSON.stringify(rows.results)).not.toContain(h.body.code)

    const ok = await redeem(admin, h.body.code, id)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true })
    const again = await redeem(admin, h.body.code, id)
    expect(again.status).toBe(400)
    expect(again.body.error).toBe('invalid_handoff')
  })

  it('another account can’t redeem it, and trying spends it', async () => {
    const admin = await makeAdmin()
    const other = await makeMember(admin)
    const id = crypto.randomUUID()
    await register(admin, id)
    await register(other, id)
    const h = await handoff(admin, id)
    expect((await redeem(other, h.body.code, id)).status).toBe(400)
    expect((await redeem(admin, h.body.code, id)).status).toBe(400)
  })

  it('a code for one device doesn’t work on another', async () => {
    const admin = await makeAdmin()
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    await register(admin, a)
    await register(admin, b)
    const h = await handoff(admin, a)
    expect((await redeem(admin, h.body.code, b)).status).toBe(400)
  })

  it('expires after 60 seconds', async () => {
    const admin = await makeAdmin()
    const id = crypto.randomUUID()
    await register(admin, id)
    const h = await handoff(admin, id)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + HANDOFF_TTL_MS + 1)
    expect((await redeem(admin, h.body.code, id)).status).toBe(400)
  })

  it('is refused for an unknown device, one with phones turned off, or one long gone', async () => {
    const admin = await makeAdmin()
    expect((await handoff(admin, crypto.randomUUID())).status).toBe(404)
    const off = crypto.randomUUID()
    await register(admin, off, laptop({ lan: false, lanUrls: [] }))
    const r = await handoff(admin, off)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('lan_off')

    const gone = crypto.randomUUID()
    await register(admin, gone)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60_000)
    expect((await handoff(admin, gone)).body.error).toBe('device_offline')
  })

  it('limits outstanding codes per account', async () => {
    const admin = await makeAdmin()
    const id = crypto.randomUUID()
    await register(admin, id)
    for (let i = 0; i < 10; i++) expect((await handoff(admin, id)).status).toBe(201)
    expect((await handoff(admin, id)).status).toBe(429)
  })

  it('rejects malformed redeem bodies', async () => {
    const admin = await makeAdmin()
    expect((await call('POST', '/v1/handoff/redeem', { token: admin.token, body: { code: 'nxs_' + 'a'.repeat(43), deviceId: crypto.randomUUID() } })).status).toBe(400)
    expect((await call('POST', '/v1/handoff/redeem', { token: admin.token, body: { code: 'nxh_' + 'a'.repeat(43), deviceId: 'x' } })).status).toBe(400)
  })
})
