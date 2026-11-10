import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { bootstrapInvite } from '../src/bootstrap.ts'

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

export async function login (email: string, password = PASSWORD, ip = uniqueIp()): Promise<Res> {
  return call('POST', '/v1/auth/login', { body: { email, password }, ip })
}

async function signIn (email: string, password = PASSWORD): Promise<User> {
  const r = await login(email, password)
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`)
  return { id: r.body.account.id, email, token: r.body.token, role: r.body.account.role }
}

/** Runs the real bootstrap SQL (forced, since tests share one database) and signs up through it. */
export async function makeAdmin (): Promise<User> {
  const { token, sql } = await bootstrapInvite({ force: true })
  await env.DB.prepare(sql).run()
  const email = uniqueEmail('admin')
  const r = await call('POST', '/v1/invites/accept', { body: { token, email, password: PASSWORD, displayName: 'Owner' } })
  if (r.status !== 201) throw new Error(`bootstrap accept: ${r.status} ${JSON.stringify(r.body)}`)
  return signIn(email)
}

export async function invite (by: User, note?: string): Promise<{ id: string; token: string; url: string; expiresAt: number }> {
  const r = await call('POST', '/v1/invites', { token: by.token, body: note === undefined ? undefined : { note } })
  if (r.status !== 201) throw new Error(`invite: ${r.status} ${JSON.stringify(r.body)}`)
  return { id: r.body.invite.id, token: r.body.token, url: r.body.url, expiresAt: r.body.invite.expiresAt }
}

export async function makeMember (inviter: User, name = 'Friend'): Promise<User> {
  const inv = await invite(inviter)
  const email = uniqueEmail('member')
  const r = await call('POST', '/v1/invites/accept', { body: { token: inv.token, email, password: PASSWORD, displayName: name } })
  if (r.status !== 201) throw new Error(`accept: ${r.status} ${JSON.stringify(r.body)}`)
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
