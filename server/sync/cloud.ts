import { pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { KDF, KDF_ITERATIONS } from '../../cloud/src/crypto.ts'
import type { Batch, MusicBatch } from '../../cloud/src/wire.ts'

// The nexttupp cloud API (cloud/README.md), as the local server calls it. Passwords are stretched here
// with PBKDF2-SHA256 and never sent; the cloud only sees the derived key.

export { KDF_ITERATIONS }

/** A failed cloud call. `status` 0 means the cloud couldn't be reached (offline, DNS, timeout). */
export class CloudError extends Error {
  readonly status: number
  readonly code: string
  constructor (status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface CloudAccount { id: string; email: string; displayName: string | null; role: 'admin' | 'member'; createdAt: number }
export interface PullPage extends Batch {
  cursor: string
  more: boolean
  serverTime: number
  /** Where the account's music last changed. Missing from a Worker that doesn't sync music (before 0005). */
  musicHead?: string
}
export interface MusicPullPage extends MusicBatch { cursor: string; more: boolean; serverTime: number }

const pbkdf2Async = promisify(pbkdf2)

/** PBKDF2-SHA256(password, salt, iterations) → 32 bytes, base64url. Runs on libuv's pool, off the event loop. */
export async function deriveKey (password: string, salt: string, iterations: number): Promise<string> {
  const bytes = Buffer.from(salt, 'base64url')
  return (await pbkdf2Async(password.normalize('NFC'), bytes, iterations, 32, 'sha256')).toString('base64url')
}

export const newSalt = (): string => randomBytes(16).toString('base64url')

export class CloudClient {
  readonly baseUrl: string
  private readonly fetch: typeof fetch

  constructor (baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetch = fetchImpl
  }

  async request<T> (method: string, path: string, opts: { token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'nexttupp' }
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
    } catch (err) {
      const timeout = (err as Error).name === 'TimeoutError'
      throw new CloudError(0, timeout ? 'timeout' : 'offline', timeout ? 'The sync service took too long to answer' : 'Can’t reach the sync service')
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let body: Record<string, unknown> = {}
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { /* not JSON, e.g. a proxy's error page */ }
    if (!res.ok) {
      throw new CloudError(res.status, typeof body.error === 'string' ? body.error : 'http_error', typeof body.message === 'string' ? body.message : `The sync service answered ${res.status}`)
    }
    return body as T
  }

  prelogin (email: string) {
    return this.request<{ kdf: string; iterations: number; salt: string }>('POST', '/v1/auth/prelogin', { body: { email } })
  }

  /** prelogin, derive the key, log in. Returns the session and the key (so a fresh sign-up needn't derive twice). */
  async login (email: string, password: string): Promise<{ token: string; expiresAt: number; account: CloudAccount }> {
    const pre = await this.prelogin(email)
    if (pre.kdf !== KDF || !Number.isInteger(pre.iterations) || pre.iterations < 100_000 || pre.iterations > 5_000_000) {
      throw new CloudError(400, 'unsupported_kdf', 'This version of nexttupp can’t sign in to this account. Update nexttupp.')
    }
    return this.loginWithKey(email, await deriveKey(password, pre.salt, pre.iterations))
  }

  loginWithKey (email: string, key: string) {
    return this.request<{ token: string; expiresAt: number; account: CloudAccount }>('POST', '/v1/auth/login', { body: { email, key } })
  }

  /** Create an account. Returns the key it derived, for logging in straight after. */
  async signup (email: string, password: string, displayName?: string): Promise<{ account: CloudAccount; key: string }> {
    const salt = newSalt()
    const key = await deriveKey(password, salt, KDF_ITERATIONS)
    const body: Record<string, unknown> = { email, salt, iterations: KDF_ITERATIONS, key }
    if (displayName) body.displayName = displayName
    const r = await this.request<{ account: CloudAccount }>('POST', '/v1/auth/signup', { body })
    return { account: r.account, key }
  }

  logout (token: string) { return this.request<void>('POST', '/v1/auth/logout', { token, timeoutMs: 5000 }) }
  account (token: string) { return this.request<{ account: CloudAccount }>('GET', '/v1/account', { token }) }
  push (token: string, batch: Batch) {
    return this.request<{ applied: Record<string, number>; serverTime: number }>('POST', '/v1/sync/push', { token, body: batch, timeoutMs: 30_000 })
  }

  // Devices and phone handoff (cloud/README.md, "Devices and phone handoff").
  putDevice (token: string, device: { id: string; name: string; platform: string; lan: boolean; lanUrls: string[] }) {
    const { id, ...body } = device
    return this.request<{ device: unknown }>('PUT', `/v1/devices/${id}`, { token, body, timeoutMs: 10_000 })
  }

  deleteDevice (token: string, id: string) { return this.request<void>('DELETE', `/v1/devices/${id}`, { token, timeoutMs: 5000 }) }
  redeemHandoff (token: string, code: string, deviceId: string) {
    return this.request<{ ok: true }>('POST', '/v1/handoff/redeem', { token, body: { code, deviceId }, timeoutMs: 10_000 })
  }

  pull (token: string, since: string, limit = 500) {
    return this.request<PullPage>('GET', `/v1/sync/pull?since=${encodeURIComponent(since)}&limit=${limit}`, { token, timeoutMs: 30_000 })
  }

  // Music (cloud/README.md, "Music"): only called when the film pull reported a musicHead.
  musicPush (token: string, batch: MusicBatch) {
    return this.request<{ applied: Record<string, number>; musicHead: string; serverTime: number }>('POST', '/v1/sync/music/push', { token, body: batch, timeoutMs: 30_000 })
  }

  musicPull (token: string, since: string, limit = 500) {
    return this.request<MusicPullPage>('GET', `/v1/sync/music/pull?since=${encodeURIComponent(since)}&limit=${limit}`, { token, timeoutMs: 30_000 })
  }
}
