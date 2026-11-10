import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError } from '../http.ts'
import { CloudError } from './cloud.ts'
import type { SyncService } from './service.ts'

// The web app's view of sign-in and sync. The session token stays in the server; the browser only ever
// sees the account's email and the sync status.
//
//   GET  /api/account            status: { signedIn, account?, sync?, notice? }
//   POST /api/account/login      { email, password }                        → status + { merged }
//   POST /api/account/join       { code, email, password, displayName? }    → status + { merged }
//   POST /api/account/logout     {}                                         → status
//   POST /api/account/sync       {}                                         → status after one sync
//   GET  /api/account/invites                                               → { invites }
//   POST /api/account/invites    { note? }                                  → { code, url, invite }

function text (v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${name} is required`)
  return v
}

function password (v: unknown, isNew: boolean): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'Password is required')
  const chars = [...v].length
  if (isNew && (chars < 8 || chars > 256 || !v.trim())) throw new HttpError(400, 'Use a password of 8 to 256 characters')
  if (chars > 1024) throw new HttpError(400, 'That password is too long')
  return v
}

/** Cloud failures, worded for the person in front of the app. */
function toHttp (err: unknown): Error {
  if (!(err instanceof CloudError)) return err as Error
  if (err.status === 0) return new HttpError(503, 'Can’t reach nexttupp’s sync service. Check your connection and try again.')
  if (err.code === 'invalid_credentials') return new HttpError(401, 'Wrong email or password')
  if (err.code === 'too_many_attempts') return new HttpError(429, err.message)
  if (err.code === 'invalid_invite') return new HttpError(400, 'That invite is invalid, already used or expired. Ask for a new one.')
  if (err.code === 'email_taken') return new HttpError(409, 'There’s already an account with that email. Sign in instead.')
  return new HttpError(err.status >= 400 && err.status < 500 ? err.status : 502, err.message)
}

export function registerAccountRoutes (app: FastifyInstance, sync: SyncService): void {
  // Writes need a JSON body and a same-site caller, so another website open in the browser can't sign
  // this computer out or start syncs (a JSON request from another origin needs a preflight, which fails).
  const guard = (req: FastifyRequest) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Not allowed from another site')
  }
  const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const withMerged = (status: object) => ({ ...status, merged: sync.lastMerge })

  app.get('/api/account', async () => sync.status())

  app.post('/api/account/login', async req => {
    guard(req)
    const b = body(req)
    try {
      return withMerged(await sync.login(text(b.email, 'Email', 254), password(b.password, false)))
    } catch (err) { throw toHttp(err) }
  })

  app.post('/api/account/join', async req => {
    guard(req)
    const b = body(req)
    const name = typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName.trim().slice(0, 40) : undefined
    try {
      return withMerged(await sync.join(text(b.code, 'Invite code', 2000), text(b.email, 'Email', 254), password(b.password, true), name))
    } catch (err) { throw toHttp(err) }
  })

  app.post('/api/account/logout', async req => {
    guard(req)
    return sync.logout()
  })

  app.post('/api/account/sync', async req => {
    guard(req)
    await Promise.race([sync.syncNow(), new Promise(resolve => setTimeout(resolve, 20_000).unref())])
    return sync.status()
  })

  app.get('/api/account/invites', async () => {
    try { return { invites: await sync.invites() } } catch (err) { throw toHttp(err) }
  })

  app.post('/api/account/invites', async (req, reply) => {
    guard(req)
    const note = body(req).note
    try {
      return reply.code(201).send(await sync.createInvite(typeof note === 'string' ? note.slice(0, 80) : undefined))
    } catch (err) { throw toHttp(err) }
  })

  // A taste or profile change (not the player's progress pings, which the minute timer carries) syncs
  // a couple of seconds later.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400) return
    const path = req.url.split('?')[0]
    if (path.startsWith('/api/profiles') || (path.startsWith('/api/me/') && !(req.method === 'POST' && path === '/api/me/progress'))) sync.nudge()
  })
}
