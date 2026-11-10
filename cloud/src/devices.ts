import { authenticate, clientIp, serverKey } from './auth.ts'
import { b64url, HANDOFF_CODE, keyedHash, randomToken, sha256Hex } from './crypto.ts'
import { bad, type Ctx, empty, type Env, HttpError, json, onlyKeys, readJson } from './http.ts'
import { oneOf, plainText, UUID } from './validate.ts'

// Watch at home. A computer running nexttupp registers itself while signed in (a heartbeat about once a
// minute) with a name and its addresses on the home network. A phone signed in to the same account lists
// them, sees which share its network, and asks for a one-time handoff code for one. It then opens
// http://<lan address>/handoff?code=… on that computer, which redeems the code here with its own session:
// only the same account and the right device can, once, within 60 seconds.
//
// "Same network" compares HMACs of the caller's IP (an IPv6 address's /64), so no IP address is stored.

export const HANDOFF_TTL_MS = 60_000
/** A device counts as running if it called within this long (it calls about once a minute). */
export const ONLINE_MS = 2 * 60_000
/** Handoffs are refused for a device that hasn't called in this long: it isn't there to redeem the code. */
const REACHABLE_MS = 10 * 60_000
const DEVICE_LIMIT = 20
const DEVICE_RETENTION_MS = 90 * 24 * 3600_000
const PENDING_HANDOFFS = 10
const MAX_URLS = 4
const SMALL_BODY = 4096

export type Platform = 'linux' | 'mac' | 'windows' | 'other'

interface DeviceRow {
  account_id: string
  id: string
  name: string
  platform: Platform
  lan: number
  lan_urls: string
  net_hash: string | null
  created_at: number
  last_seen_at: number
}

export interface DeviceJson {
  id: string
  name: string
  platform: Platform
  /** "Watch on phones and TVs at home" is on, and lanUrls says where. */
  lan: boolean
  lanUrls: string[]
  lastSeenAt: number
  /** Called within the last two minutes. */
  online: boolean
  /** Its last call came from the same network as this request. */
  sameNetwork: boolean
}

const deviceJson = (d: DeviceRow, callerNet: string | null, now: number): DeviceJson => ({
  id: d.id,
  name: d.name,
  platform: d.platform,
  lan: d.lan === 1,
  lanUrls: JSON.parse(d.lan_urls) as string[],
  lastSeenAt: d.last_seen_at,
  online: now - d.last_seen_at < ONLINE_MS,
  sameNetwork: callerNet !== null && d.net_hash === callerNet,
})

// ---- Network identity ---------------------------------------------------------------------

/** The part of an address shared by every device on one home network: an IPv4 address, or an IPv6 /64. */
export function networkKey (ip: string): string | null {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (v4) return v4[1].split('.').every(o => Number(o) <= 255) ? `4:${v4[1]}` : null
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(':')) return null
  const [head, tail, extra] = ip.toLowerCase().split('::')
  if (extra !== undefined) return null
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return `6:${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}`
}

async function networkHash (env: Env, req: Request): Promise<string | null> {
  const key = networkKey(clientIp(req))
  return key ? b64url(await keyedHash(await serverKey(env), `network:${key}`)) : null
}

// ---- Validation ---------------------------------------------------------------------------

const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/

/** `http://<private IPv4>:<port>`, nothing else: phones are only ever sent to an address on a home network. */
export function lanUrl (v: unknown, path: string): string {
  const m = typeof v === 'string' ? /^http:\/\/([0-9.]+):(\d{1,5})$/.exec(v) : null
  if (!m || !PRIVATE_V4.test(m[1]) || m[1].split('.').some(o => Number(o) > 255) || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    throw bad(`${path}: must be http://<private IPv4 address>:<port>`)
  }
  return v as string
}

function deviceId (ctx: Ctx): string {
  const id = ctx.params[0]
  if (!UUID.test(id)) throw bad('device id: must be a lowercase UUID')
  return id
}

// ---- Handlers -----------------------------------------------------------------------------

/** PUT /v1/devices/:id: register or refresh this computer. The app calls it about once a minute. */
export async function putDevice (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const id = deviceId(ctx)
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['name', 'platform', 'lan', 'lanUrls'])
  const name = plainText(body.name, 'name', 40)
  const platform = oneOf(body.platform, 'platform', ['linux', 'mac', 'windows', 'other'] as const)
  if (typeof body.lan !== 'boolean') throw bad('lan: must be a boolean')
  if (!Array.isArray(body.lanUrls) || body.lanUrls.length > MAX_URLS) throw bad(`lanUrls: must be an array of at most ${MAX_URLS} addresses`)
  const urls = body.lanUrls.map((u, i) => lanUrl(u, `lanUrls[${i}]`))
  if (!body.lan && urls.length) throw bad('lanUrls: must be empty when lan is false')

  const { env, now } = ctx
  const net = await networkHash(env, ctx.req)
  const [, , , row] = await env.DB.batch<DeviceRow>([
    env.DB.prepare(`INSERT INTO devices (account_id, id, name, platform, lan, lan_urls, net_hash, created_at, last_seen_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                    ON CONFLICT (account_id, id) DO UPDATE SET name = excluded.name, platform = excluded.platform, lan = excluded.lan,
                      lan_urls = excluded.lan_urls, net_hash = excluded.net_hash, last_seen_at = excluded.last_seen_at`)
      .bind(s.account.id, id, name, platform, body.lan ? 1 : 0, JSON.stringify(urls), net, now),
    env.DB.prepare(`DELETE FROM devices WHERE account_id = ?1 AND id NOT IN
                      (SELECT id FROM devices WHERE account_id = ?1 ORDER BY last_seen_at DESC LIMIT ?2)`).bind(s.account.id, DEVICE_LIMIT),
    env.DB.prepare('DELETE FROM devices WHERE last_seen_at < ?').bind(now - DEVICE_RETENTION_MS),
    env.DB.prepare('SELECT * FROM devices WHERE account_id = ? AND id = ?').bind(s.account.id, id),
  ])
  return json({ device: deviceJson(row.results[0], net, now) })
}

/** GET /v1/devices: this account's computers, most recently seen first. */
export async function listDevices (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const [net, rows] = await Promise.all([
    networkHash(ctx.env, ctx.req),
    ctx.env.DB.prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY last_seen_at DESC').bind(s.account.id).all<DeviceRow>(),
  ])
  return json({ devices: rows.results.map(d => deviceJson(d, net, ctx.now)), serverTime: ctx.now })
}

/** DELETE /v1/devices/:id: the app signs out. Idempotent. */
export async function deleteDevice (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const id = deviceId(ctx)
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM devices WHERE account_id = ? AND id = ?').bind(s.account.id, id),
    ctx.env.DB.prepare('DELETE FROM handoffs WHERE account_id = ? AND device_id = ?').bind(s.account.id, id),
  ])
  return empty()
}

/** POST /v1/devices/:id/handoff (the phone): a one-time code that device will accept for the next 60 s. */
export async function createHandoff (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const id = deviceId(ctx)
  const { env, now } = ctx
  const [devices, pending] = await env.DB.batch<DeviceRow | { n: number }>([
    env.DB.prepare('SELECT * FROM devices WHERE account_id = ? AND id = ?').bind(s.account.id, id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM handoffs WHERE account_id = ? AND expires_at > ?').bind(s.account.id, now),
    env.DB.prepare('DELETE FROM handoffs WHERE expires_at <= ?').bind(now),
  ])
  const device = devices.results[0] as DeviceRow | undefined
  if (!device) throw new HttpError(404, 'not_found', 'That computer isn’t signed in to this account any more')
  if (device.lan !== 1) throw new HttpError(409, 'lan_off', `Watching on phones is turned off on ${device.name}. Turn it on in nexttupp, under Account.`)
  if (now - device.last_seen_at > REACHABLE_MS) throw new HttpError(409, 'device_offline', `${device.name} hasn’t been online for a while. Open nexttupp on it and try again.`)
  if ((pending.results[0] as { n: number }).n >= PENDING_HANDOFFS) {
    throw new HttpError(429, 'too_many_attempts', 'Too many tries at once. Wait a minute and try again.', { 'retry-after': '60' })
  }
  const code = randomToken('nxh_')
  const expiresAt = now + HANDOFF_TTL_MS
  await env.DB.prepare('INSERT INTO handoffs (code_hash, account_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(code), s.account.id, id, now, expiresAt).run()
  return json({ code, expiresAt, lanUrls: JSON.parse(device.lan_urls) as string[] }, 201)
}

/**
 * POST /v1/handoff/redeem (the computer, with its own session): `{ code, deviceId }`. The code is spent by
 * the first attempt, right or wrong, so it can't be tried twice. Valid only for the account and device it
 * was made for, within 60 seconds.
 */
export async function redeemHandoff (ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const body = await readJson(ctx.req, SMALL_BODY)
  onlyKeys(body, ['code', 'deviceId'])
  if (typeof body.code !== 'string' || !HANDOFF_CODE.test(body.code)) throw bad('code: must be a handoff code')
  if (typeof body.deviceId !== 'string' || !UUID.test(body.deviceId)) throw bad('deviceId: must be a lowercase UUID')
  const row = await ctx.env.DB.prepare('DELETE FROM handoffs WHERE code_hash = ? RETURNING account_id, device_id, expires_at')
    .bind(await sha256Hex(body.code)).first<{ account_id: string; device_id: string; expires_at: number }>()
  if (!row || row.expires_at <= ctx.now || row.account_id !== s.account.id || row.device_id !== body.deviceId) {
    throw new HttpError(400, 'invalid_handoff', 'That link has expired or was already used. Try again from nexttupp.com.')
  }
  return json({ ok: true })
}
