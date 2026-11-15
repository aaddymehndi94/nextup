import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError } from '../http.ts'
import { CloudError } from './cloud.ts'
import type { SyncService } from './service.ts'

// The web app's view of sign-in and sync. The session token stays in the server; the browser only ever
// sees the account's email and the sync status.
//
//   GET  /api/account            status: { signedIn, account?, sync?, notice? }
//   POST /api/account/code       { email }                                  → 204, a code is emailed
//   POST /api/account/verify     { email, code, displayName? }              → status + { merged }
//   POST /api/account/focus      { focused }                                → 204 (sync's events)
//   POST /api/account/logout     {}                                         → status
//   POST /api/account/sync       {}                                         → status after one sync

function text (v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${name} is required`)
  return v
}

/** Cloud failures, worded for the person in front of the app. */
function toHttp (err: unknown): Error {
  if (!(err instanceof CloudError)) return err as Error
  if (err.status === 0) return new HttpError(503, 'Can’t reach nexttupp’s sync service. Check your connection and try again.')
  if (err.code === 'too_many_attempts') return new HttpError(429, err.message)
  if (err.status === 400 && /^email/.test(err.message)) return new HttpError(400, 'That email doesn’t look right. Check it and try again.')
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

  // Signing in, which also creates the account the first time: an email, then the 6-digit code sent to it.
  app.post('/api/account/code', async (req, reply) => {
    guard(req)
    try {
      await sync.sendCode(text(body(req).email, 'Email', 254))
    } catch (err) { throw toHttp(err) }
    return reply.code(204).send()
  })

  app.post('/api/account/verify', async req => {
    guard(req)
    const b = body(req)
    const name = typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName.trim().slice(0, 40) : undefined
    const code = text(b.code, 'Code', 12).replace(/\D/g, '')
    if (code.length !== 6) throw new HttpError(400, 'The code is the 6 digits in the email')
    try {
      return withMerged(await sync.verifyCode(text(b.email, 'Email', 254), code, name))
    } catch (err) { throw toHttp(err) }
  })

  app.post('/api/account/logout', async req => {
    guard(req)
    return sync.logout()
  })

  // The app was opened or came back into view (fetch the other computers' changes, now and then), or was left
  // (upload what's waiting). The cloud is only called on events like these, never on a timer.
  app.post('/api/account/focus', async (req, reply) => {
    guard(req)
    sync.focus(body(req).focused === true)
    return reply.code(204).send()
  })

  app.post('/api/account/sync', async req => {
    guard(req)
    await Promise.race([sync.syncNow(), new Promise(resolve => setTimeout(resolve, 20_000).unref())])
    return sync.status()
  })

  // A taste or profile change syncs a few seconds later; the player's progress saves only when it closes
  // (final). For music: a like or an AI mix; listens and mood mixes wait for the next sync.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400) return
    const path = req.url.split('?')[0]
    const progress = req.method === 'POST' && path === '/api/me/progress'
    if (progress ? body(req).final === true : path.startsWith('/api/profiles') || path.startsWith('/api/me/')) sync.nudge()
    else if (req.method === 'POST' && (path === '/api/music/rate' || path === '/api/music/ai')) sync.nudge()
  })
}
