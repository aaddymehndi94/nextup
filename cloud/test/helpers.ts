import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { b64url, fromB64url, KDF_ITERATIONS } from '../src/crypto.ts'

export const BASE = 'https://cloud.test'
export const PASSWORD = 'correct horse battery'

let counter = 0
/** Unique per call, so tests sharing one database never collide. */
export const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
export const uniqueEmail = (who = 'user') => `${who}-${uniq()}@example.com`
/** A fresh client IP per test keeps the per-IP login throttle from leaking between tests. */
export const uniqueIp = () => `10.${(counter++ >> 8) & 255}.${counter & 255}.${Math.floor(Math.random() * 250) + 1}`

export interface Res<T = any> { status: number; body: T; headers: Headers }

export async function call<T = any> (method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { 'cf-connecting-ip': opts.ip ?? '192.0.2.1', ...opts.headers }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  let body: string | undefined
  if (opts.raw !== undefined) body = opts.raw
  else if (opts.body !== undefined) body = JSON.stringify(opts.body)
  if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json'
  const res = await SELF.fetch(new Request(BASE + path, { method, headers, body }))
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  return { status: res.status, body: parsed as T, headers: res.headers }
}

export interface User { id: string; email: string; token: string; role: string }

/**
 * The client's key derivation, stood in for by one SHA-256: workerd refuses PBKDF2 above 100,000
 * iterations, and the server treats the key as opaque 32 bytes anyway. The real client runs
 * PBKDF2-SHA256(password, salt, 600000) (server/sync/cloud.ts, src/pages.ts).
 */
export async function deriveKey (password: string, salt: string): Promise<string> {
  const saltBytes = fromB64url(salt)!
  const data = new Uint8Array([...saltBytes, ...new TextEncoder().encode(password)])
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
}

/** A new credential for sign-up, reset or password change: a fresh salt, the iterations and the key. */
export async function credential (password = PASSWORD): Promise<{ salt: string; iterations: number; key: string }> {
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)))
  return { salt, iterations: KDF_ITERATIONS, key: await deriveKey(password, salt) }
}

export const prelogin = (email: string) => call('POST', '/v1/auth/prelogin', { body: { email } })

/** What the client does: prelogin for the salt, derive the key, log in with it. */
export async function login (email: string, password = PASSWORD, ip = uniqueIp()): Promise<Res> {
  const pre = await prelogin(email)
  if (pre.status !== 200) throw new Error(`prelogin: ${pre.status} ${JSON.stringify(pre.body)}`)
  return call('POST', '/v1/auth/login', { body: { email, key: await deriveKey(password, pre.body.salt) }, ip })
}

/** Signs up, from a fresh IP unless one is given. `extra` adds or overrides body fields. */
export async function signup (email: string, password = PASSWORD, extra: Record<string, unknown> = {}, ip = uniqueIp()): Promise<Res> {
  return call('POST', '/v1/auth/signup', { body: { email, ...await credential(password), ...extra }, ip })
}

async function signIn (email: string, password = PASSWORD): Promise<User> {
  const r = await login(email, password)
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`)
  return { id: r.body.account.id, email, token: r.body.token, role: r.body.account.role }
}

export async function makeMember (name = 'Friend'): Promise<User> {
  const email = uniqueEmail('member')
  const r = await signup(email, PASSWORD, { displayName: name })
  if (r.status !== 201) throw new Error(`signup: ${r.status} ${JSON.stringify(r.body)}`)
  return signIn(email)
}

/** Signs up, then promotes the account the way the README's "first admin" step does, straight in D1. */
export async function makeAdmin (): Promise<User> {
  const email = uniqueEmail('admin')
  const r = await signup(email, PASSWORD, { displayName: 'Owner' })
  if (r.status !== 201) throw new Error(`signup: ${r.status} ${JSON.stringify(r.body)}`)
  await env.DB.prepare("UPDATE accounts SET role = 'admin' WHERE email = ?").bind(email).run()
  return signIn(email)
}

// ---- Sync payload builders ---------------------------------------------------------------

export const T0 = Date.UTC(2026, 9, 1)

export function profile (over: Partial<Record<string, unknown>> = {}) {
  return { id: crypto.randomUUID(), name: 'Me', avatar: null, createdAt: T0, updatedAt: T0, deletedAt: null, ...over }
}

export function progressRow (profileId: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    profileId, streamId: 'tt0133093', itemId: 'tt0133093', itemType: 'movie', season: null, episode: null,
    position: 600, duration: 8160, maxPosition: 600, watchedSec: 600, completedAt: null, startedAt: T0, updatedAt: T0 + 1000,
    hidden: 0, forgotten: 0, ...over,
  }
}

export const push = (u: User, body: unknown) => call('POST', '/v1/sync/push', { token: u.token, body })
export const pull = (u: User, since = '0', limit?: number) => call('GET', `/v1/sync/pull?since=${since}${limit ? `&limit=${limit}` : ''}`, { token: u.token })
