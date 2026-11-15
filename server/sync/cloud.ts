import type { Batch, MusicBatch } from '../../cloud/src/wire.ts'

// The nexttupp cloud API (cloud/README.md), as the local server calls it. Signing in is by a code sent by
// email (no passwords); the session token stays on this computer.

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

/** The notice header is URI-encoded so any text survives it; shown as plain text, at most one short line. */
function readNotice (raw: string | null): string | null {
  if (!raw) return null
  try { return decodeURIComponent(raw).replace(/\s+/g, ' ').trim().slice(0, 200) || null } catch { return null }
}

export class CloudClient {
  readonly baseUrl: string
  private readonly fetch: typeof fetch
  private readonly appVersion?: string
  /** The owner's one-line notice, from the last answer (x-nexttupp-notice); null when there is none. */
  announcement: string | null = null
  /** Set once the cloud says this version is too old: from then on, nothing is sent until the app is updated. */
  updateRequired: string | null = null

  constructor (baseUrl: string, fetchImpl: typeof fetch = fetch, appVersion?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetch = fetchImpl
    this.appVersion = appVersion
  }

  async request<T> (method: string, path: string, opts: { token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    if (this.updateRequired) throw new CloudError(426, 'update_required', this.updateRequired)
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'nexttupp' }
    // The cloud's owner can turn away versions that are too old, and only apps say theirs (cloud/src/index.ts).
    if (this.appVersion) headers['x-nexttupp-app'] = this.appVersion
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
    this.announcement = readNotice(res.headers.get('x-nexttupp-notice'))
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let body: Record<string, unknown> = {}
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { /* not JSON, e.g. a proxy's error page */ }
    if (!res.ok) {
      const err = new CloudError(res.status, typeof body.error === 'string' ? body.error : 'http_error', typeof body.message === 'string' ? body.message : `The sync service answered ${res.status}`)
      if (err.code === 'update_required') this.updateRequired = err.message
      throw err
    }
    return body as T
  }

  /** Where "Continue with Google" starts for this app: Google sends the browser back to 127.0.0.1:`port`. */
  googleLink (port: number, challenge: string): string {
    return `${this.baseUrl}/v1/auth/google?${new URLSearchParams({ to: 'app', port: String(port), challenge })}`
  }

  /** Turns the ticket Google's round trip ended with into a session, with the secret behind the link's challenge. */
  redeemTicket (ticket: string, secret: string) {
    return this.request<{ token: string; expiresAt: number; account: CloudAccount; created: boolean }>('POST', '/v1/auth/ticket', { body: { ticket, secret } })
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
