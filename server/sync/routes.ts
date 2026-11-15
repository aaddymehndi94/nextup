import type { FastifyInstance, FastifyRequest } from 'fastify'
import { HttpError } from '../http.ts'
import { isLoopback } from '../lan/net.ts'
import { CloudError } from './cloud.ts'
import type { SyncService } from './service.ts'

// The web app's view of sign-in and sync. The session token stays in the server; the browser only ever
// sees the account's email and the sync status.
//
//   GET  /api/account            status: { signedIn, account?, sync?, notice? }
//   POST /api/account/google     {}                                         → { url } to open in the browser
//   POST /api/account/google/finish { ticket }                              → status + { merged }
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

  // `merged`: how the last sign-in matched this computer's profiles to the account's (the app follows it).
  app.get('/api/account', async () => withMerged(sync.status()))

  app.post('/api/account/logout', async req => {
    guard(req)
    return sync.logout()
  })

  // "Continue with Google", on this computer only (a phone's browser can't come back to 127.0.0.1 here): the
  // link opens in the browser, and Google's round trip ends at this server's /auth/google page with a ticket,
  // which that page posts back here. The port is the one this request came in on.
  const here = (req: FastifyRequest) => {
    if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(403, 'Sign in on the computer that runs nexttupp.')
  }
  app.post('/api/account/google', async req => {
    guard(req)
    here(req)
    return { url: sync.googleLink(req.socket.localPort ?? 4545) }
  })
  app.post('/api/account/google/finish', async req => {
    guard(req)
    here(req)
    const ticket = text(body(req).ticket, 'Ticket', 100)
    try {
      return withMerged(await sync.finishGoogle(ticket))
    } catch (err) { throw toHttp(err) }
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
