import Fastify from 'fastify'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudError } from '../sync/cloud.ts'
import { addressFacing, clientLabel, defaultDeviceName, isLoopback, isLoopbackHost, lanAddresses } from './net.ts'
import { registerLanGate, registerLanRoutes } from './routes.ts'
import { LanService } from './service.ts'
import { COOKIE, readCookie } from './store.ts'

const dirs: string[] = []
const services: LanService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PHONE = '192.168.1.50'
const CODE = `nxh_${'A'.repeat(43)}`
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

async function setup (opts: { signedIn?: boolean; redeem?: (code: string, id: string) => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nx-lan-'))
  dirs.push(dir)
  const state = { signedIn: opts.signedIn ?? true, redeemed: [] as Array<[string, string]>, nudged: 0 }
  const lan = new LanService({ dataDir: dir, port: 4552, host: '127.0.0.1', signedIn: () => state.signedIn, addresses: async () => [] })
  services.push(lan)
  const app = Fastify()
  app.setErrorHandler((err: Error & { status?: number }, _req, reply) => { reply.code(err.status ?? 500).send({ error: err.message }) })
  registerLanGate(app, lan)
  registerLanRoutes(app, lan, {
    signedIn: () => state.signedIn,
    redeemHandoff: opts.redeem ?? (async (code, id) => { state.redeemed.push([code, id]) }),
    nudge: () => { state.nudged++ },
  })
  app.get('/api/health', async () => ({ ok: true }))
  app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><title>app</title>'))
  app.post('/api/account/logout', async () => ({ signedIn: false }))
  app.get('/cast/:token/raw', async () => 'video bytes')
  await app.ready()
  return { app, lan, state, dir }
}

const fromLocal = (host = 'localhost:4552') => ({ remoteAddress: '127.0.0.1', headers: { host } })
const fromPhone = (headers: Record<string, string> = {}) => ({ remoteAddress: PHONE, headers: { host: '192.168.1.20:4552', 'user-agent': ANDROID, ...headers } })

/** Runs the handoff as a phone would and returns its cookie header value. */
async function connectPhone (app: Awaited<ReturnType<typeof setup>>['app']): Promise<string> {
  const r = await app.inject({ method: 'GET', url: `/handoff?code=${CODE}`, ...fromPhone() })
  expect(r.statusCode).toBe(303)
  const set = String(r.headers['set-cookie'])
  return `${COOKIE}=${readCookie(set.split(';')[0], COOKIE)}`
}

describe('the LAN gate', () => {
  it('lets this computer in when it names itself localhost, and refuses other Host headers (DNS rebinding)', async () => {
    const { app } = await setup()
    for (const host of ['localhost:4552', '127.0.0.1:4552', '[::1]:4552', 'localhost']) {
      expect((await app.inject({ method: 'GET', url: '/api/health', ...fromLocal(host) })).statusCode, host).toBe(200)
    }
    for (const host of ['evil.example:4552', 'localhost.evil.example', '192.168.1.20:4552']) {
      const r = await app.inject({ method: 'GET', url: '/api/health', ...fromLocal(host) })
      expect(r.statusCode, host).toBe(403)
    }
  })

  it('refuses a phone without the cookie: a page for browsers, JSON for the API', async () => {
    const { app } = await setup()
    const page = await app.inject({ method: 'GET', url: '/', ...fromPhone({ accept: 'text/html' }) })
    expect(page.statusCode).toBe(401)
    expect(page.headers['content-type']).toMatch(/text\/html/)
    expect(page.body).toContain('Open nexttupp.com on this phone and sign in to connect.')
    expect(page.headers['content-security-policy']).toContain("default-src 'none'")

    const api = await app.inject({ method: 'GET', url: '/api/health', ...fromPhone() })
    expect(api.statusCode).toBe(401)
    expect(api.json().error).toMatch(/Not connected/)
    const forged = await app.inject({ method: 'GET', url: '/api/health', ...fromPhone({ cookie: `${COOKIE}=nxl_${'x'.repeat(43)}` }) })
    expect(forged.statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/stream/abc/raw', ...fromPhone() })).statusCode).toBe(401)
  })

  it('leaves /cast/ URLs to their own token check', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/cast/t/raw', ...fromPhone() })).statusCode).toBe(200)
  })
})

describe('phone handoff', () => {
  it('redeems the code with the cloud for this device, sets an HttpOnly cookie and goes to the app', async () => {
    const { app, lan, state } = await setup()
    const r = await app.inject({ method: 'GET', url: `/handoff?code=${CODE}`, ...fromPhone() })
    expect(r.statusCode).toBe(303)
    expect(r.headers.location).toBe('/')
    expect(state.redeemed).toEqual([[CODE, lan.store.deviceId]])
    const set = String(r.headers['set-cookie'])
    expect(set).toMatch(new RegExp(`^${COOKIE}=nxl_[A-Za-z0-9_-]{43}; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax$`))

    const cookie = `${COOKIE}=${readCookie(set.split(';')[0], COOKIE)}`
    expect((await app.inject({ method: 'GET', url: '/api/health', ...fromPhone({ cookie }) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/', ...fromPhone({ cookie }) })).body).toContain('<title>app</title>')

    const clients = lan.clients()
    expect(clients).toHaveLength(1)
    expect(clients[0].label).toBe('Android phone · Chrome')
  })

  it('stores only a hash of the cookie, in a file only this user can read', async () => {
    const { app, dir } = await setup()
    const cookie = await connectPhone(app)
    const file = join(dir, 'lan.json')
    expect(readFileSync(file, 'utf8')).not.toContain(cookie.split('=')[1])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('doesn’t add the phone twice when it comes back through nexttupp.com', async () => {
    const { app, lan } = await setup()
    const cookie = await connectPhone(app)
    const again = await app.inject({ method: 'GET', url: `/handoff?code=${CODE}`, ...fromPhone({ cookie }) })
    expect(again.statusCode).toBe(303)
    expect(again.headers['set-cookie']).toBeUndefined()
    expect(lan.clients()).toHaveLength(1)
  })

  it('refuses a code the cloud rejects, a malformed one, and any while phones are off or signed out', async () => {
    const refused = await setup({ redeem: async () => { throw new CloudError(400, 'invalid_handoff', 'expired') } })
    const r = await refused.app.inject({ method: 'GET', url: `/handoff?code=${CODE}`, ...fromPhone() })
    expect(r.statusCode).toBe(401)
    expect(r.headers['set-cookie']).toBeUndefined()
    expect(r.body).toContain('That link has expired')

    const offline = await setup({ redeem: async () => { throw new CloudError(0, 'offline', 'offline') } })
    expect((await offline.app.inject({ method: 'GET', url: `/handoff?code=${CODE}`, ...fromPhone() })).statusCode).toBe(503)

    const { app, lan, state } = await setup()
    expect((await app.inject({ method: 'GET', url: '/handoff?code=nope', ...fromPhone() })).statusCode).toBe(400)
    const cookie = await connectPhone(app)
    lan.store.setEnabled(false)
    expect((await app.inject({ method: 'GET', url: `/handoff?code=${CODE}`, ...fromPhone() })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/health', ...fromPhone({ cookie }) })).statusCode).toBe(401)
    lan.store.setEnabled(true)
    expect((await app.inject({ method: 'GET', url: '/api/health', ...fromPhone({ cookie }) })).statusCode).toBe(200)
    state.signedIn = false
    expect((await app.inject({ method: 'GET', url: '/api/health', ...fromPhone({ cookie }) })).statusCode).toBe(401)
    expect(state.redeemed).toHaveLength(1)
  })

  it('on this computer itself just opens the app', async () => {
    const { app, state } = await setup()
    const r = await app.inject({ method: 'GET', url: `/handoff?code=${CODE}`, ...fromLocal() })
    expect(r.statusCode).toBe(303)
    expect(state.redeemed).toEqual([])
  })
})

describe('phones and TVs settings', () => {
  it('a phone can watch but not change account or phone settings', async () => {
    const { app } = await setup()
    const cookie = await connectPhone(app)
    const json = { 'content-type': 'application/json', cookie }
    expect((await app.inject({ method: 'POST', url: '/api/account/logout', payload: '{}', ...fromPhone(json) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: '/api/lan', payload: { enabled: false }, ...fromPhone(json) })).statusCode).toBe(403)
    const status = await app.inject({ method: 'GET', url: '/api/lan', ...fromPhone({ cookie }) })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ local: false, clients: [{ current: true, label: 'Android phone · Chrome' }] })
  })

  it('on this computer: turn phones off, rename, and remove a phone', async () => {
    const { app, lan, state } = await setup()
    const cookie = await connectPhone(app)
    const headers = { host: 'localhost:4552', 'content-type': 'application/json' }
    const off = await app.inject({ method: 'PATCH', url: '/api/lan', payload: { enabled: false }, remoteAddress: '127.0.0.1', headers })
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ local: true, enabled: false, phonesEnabled: false })
    expect(state.nudged).toBe(1)

    const named = await app.inject({ method: 'PATCH', url: '/api/lan', payload: { enabled: true, name: '  Living   room ' }, remoteAddress: '127.0.0.1', headers })
    expect(named.json()).toMatchObject({ enabled: true, name: 'Living room' })
    expect(lan.deviceInfo()).toMatchObject({ id: lan.store.deviceId, name: 'Living room', lan: true })
    const bad = await app.inject({ method: 'PATCH', url: '/api/lan', payload: { name: 'x'.repeat(41) }, remoteAddress: '127.0.0.1', headers })
    expect(bad.statusCode).toBe(400)
    const reset = await app.inject({ method: 'PATCH', url: '/api/lan', payload: { name: '' }, remoteAddress: '127.0.0.1', headers })
    expect(reset.json().name).toBe(defaultDeviceName())

    const id = lan.clients()[0].id
    expect((await app.inject({ method: 'DELETE', url: `/api/lan/clients/${id}`, remoteAddress: '127.0.0.1', headers: { host: 'localhost:4552' } })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/health', ...fromPhone({ cookie }) })).statusCode).toBe(401)
  })

  it('reports no addresses to the cloud while phones are off', async () => {
    const { lan, state } = await setup()
    state.signedIn = false
    expect(lan.deviceInfo()).toMatchObject({ lan: false, lanUrls: [] })
  })
})

describe('the LAN listener', () => {
  it('binds the home-network addresses while phones are on, and unbinds when turned off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-lan-'))
    dirs.push(dir)
    const port = 20000 + Math.floor(Math.random() * 20000)
    // 127.0.0.2 stands in for a Wi-Fi address (all of 127/8 is local on Linux).
    const lan = new LanService({ dataDir: dir, port, host: '127.0.0.1', signedIn: () => true, addresses: async () => [{ address: '127.0.0.2', netmask: '255.0.0.0', iface: 'wlan0' }] })
    services.push(lan)
    await lan.start((_req, res) => { res.end('hello') })
    expect(lan.listening).toBe(true)
    expect(lan.urls()).toEqual([`http://127.0.0.2:${port}`])
    const get = () => new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.2', port, path: '/' }, res => { let b = ''; res.on('data', d => { b += d }).on('end', () => resolve(b)) }).on('error', reject).end()
    })
    expect(await get()).toBe('hello')

    lan.store.setEnabled(false)
    await lan.refresh()
    expect(lan.listening).toBe(false)
    await expect(get()).rejects.toThrow()

    // A cast keeps it up while it runs, even with phones off.
    const release = lan.holdForCast()
    await lan.refresh()
    expect(await get()).toBe('hello')
    expect(lan.deviceInfo().lanUrls).toEqual([])
    release()
    await lan.refresh()
    expect(lan.listening).toBe(false)
  })
})

describe('network helpers', () => {
  it('knows loopback peers and Host headers', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('192.168.1.2')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
    expect(isLoopbackHost('LOCALHOST:4545')).toBe(true)
    expect(isLoopbackHost('localhost:4545.evil.example')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.nip.io')).toBe(false)
  })

  it('lists private addresses of real interfaces, the default route first', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
      docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
      eth0: [{ address: '10.0.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
      wlan0: [
        { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false },
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      ],
      wan: [{ address: '203.0.113.9', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    } as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    const list = lanAddresses('192.168.1.20', ifaces)
    expect(list.map(a => a.address)).toEqual(['192.168.1.20', '10.0.0.5'])
    expect(addressFacing('10.0.0.77', list)?.address).toBe('10.0.0.5')
    expect(addressFacing('192.168.1.99', list)?.address).toBe('192.168.1.20')
    expect(addressFacing('172.16.0.1', list)?.address).toBe('192.168.1.20')
  })

  it('names devices without the hostname', () => {
    expect(defaultDeviceName('linux', true)).toBe('Laptop (Linux)')
    expect(defaultDeviceName('win32', false)).toBe('Computer (Windows)')
    expect(defaultDeviceName('darwin', false)).toBe('Mac')
    expect(clientLabel(ANDROID)).toBe('Android phone · Chrome')
    expect(clientLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(clientLabel(undefined)).toBe('Device')
  })
})
