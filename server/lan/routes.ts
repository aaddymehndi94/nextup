import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { plainText } from '../../cloud/src/validate.ts'
import { HttpError } from '../http.ts'
import { CloudError } from '../sync/cloud.ts'
import { clientLabel, defaultDeviceName, isLoopback, isLoopbackHost } from './net.ts'
import type { LanService } from './service.ts'
import { COOKIE, COOKIE_MAX_AGE_S, type LanClient } from './store.ts'

// The LAN gate, the phone handoff, and the Account page's "Phones and TVs" settings.
//
//   GET    /handoff?code=nxh_…          a phone arriving from nexttupp.com: redeem, set the cookie, go to /
//   GET    /api/lan                     { local, signedIn, enabled, phonesEnabled, listening, name, defaultName, urls, clients }
//   PATCH  /api/lan                     { enabled?, name? }          (on this computer only)
//   DELETE /api/lan/clients/:id                                       (on this computer only)

declare module 'fastify' {
  interface FastifyRequest { lanClient: LanClient | null }
}

export const SITE_WATCH_URL = 'https://nexttupp.com/watch'
const HANDOFF_CODE = /^nxh_[A-Za-z0-9_-]{43}$/

export interface HandoffRedeemer {
  signedIn (): boolean
  redeemHandoff (code: string, deviceId: string): Promise<void>
  /** Settings changed: tell the cloud soon. */
  nudge (): void
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** A small self-contained page (inline styles, no scripts), so nothing else has to be reachable without the cookie. */
export function lanPage (title: string, message: string, action: { href: string; label: string } | null = { href: SITE_WATCH_URL, label: 'Open nexttupp.com' }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="dark"><title>${esc(title)} · nexttupp</title>
<style>
html{background:#0a0a0b;color:#f5f5f7;font:440 1rem/1.5 "Mona Sans",ui-sans-serif,system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;box-sizing:border-box}
main{max-width:26rem}
.w{font-weight:800;font-size:1.5rem;letter-spacing:-.045em;margin:0 0 2.5rem}
h1{font-size:1.5rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 .75rem;font-weight:700}
p{color:#b4b4bb;margin:0 0 1.75rem}
a.b{display:inline-flex;align-items:center;height:3rem;padding:0 1.5rem;border-radius:999px;background:#fff;color:#0a0a0b;font-weight:600;font-size:.875rem;text-decoration:none}
</style></head><body><main><p class="w" style="color:#f5f5f7">nexttupp</p><h1>${esc(title)}</h1><p>${esc(message)}</p>
${action ? `<a class="b" href="${esc(action.href)}">${esc(action.label)}</a>` : ''}</main></body></html>`
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function sendPage (reply: FastifyReply, status: number, title: string, message: string, action?: { href: string; label: string } | null) {
  return reply.code(status).headers(PAGE_HEADERS).send(lanPage(title, message, action))
}

const wantsHtml = (req: FastifyRequest) => {
  const path = req.url.split('?')[0]
  return !path.startsWith('/api/') && !path.startsWith('/stream/') && /text\/html|\*\/\*/.test(req.headers.accept ?? '*/*')
}

/**
 * Must be registered before every route. A request from this computer must name it as localhost (DNS
 * rebinding). Any other request needs a phone's cookie, except /handoff (which issues one) and /cast/…
 * (whose routes check the cast token in the URL). Phones may watch, but account settings change only here.
 */
export function registerLanGate (app: FastifyInstance, lan: LanService): void {
  app.decorateRequest('lanClient', null)
  app.addHook('onRequest', async (req, reply) => {
    if (isLoopback(req.socket.remoteAddress)) {
      if (isLoopbackHost(req.headers.host)) return
      return reply.code(403).send({ error: 'Open nexttupp at http://localhost or http://127.0.0.1.' })
    }
    const path = req.url.split('?')[0]
    if (path === '/handoff' || path.startsWith('/cast/')) return
    const client = lan.phonesEnabled() ? lan.store.verify(req.headers.cookie) : null
    if (!client) {
      if (wantsHtml(req)) return sendPage(reply, 401, 'Not connected yet', 'Open nexttupp.com on this phone and sign in to connect.')
      return reply.code(401).header('cache-control', 'no-store').send({ error: 'Not connected. Open nexttupp.com on this phone and sign in to connect.' })
    }
    req.lanClient = client
    if (req.method !== 'GET' && req.method !== 'HEAD' && /^\/api\/(account|lan)(\/|$)/.test(path)) {
      return reply.code(403).send({ error: 'Change this on the computer that runs nexttupp.' })
    }
  })
}

export function registerLanRoutes (app: FastifyInstance, lan: LanService, account: HandoffRedeemer): void {
  // Ten handoff attempts a minute is plenty for one household; it stops a LAN client hammering the cloud.
  let window = { start: 0, n: 0 }
  const allow = () => {
    const now = Date.now()
    if (now - window.start > 60_000) window = { start: now, n: 0 }
    return ++window.n <= 10
  }

  app.get<{ Querystring: { code?: string } }>('/handoff', async (req, reply) => {
    if (isLoopback(req.socket.remoteAddress)) return reply.code(303).header('location', '/').send()
    if (!lan.phonesEnabled()) {
      return sendPage(reply, 403, 'Phones are turned off on this computer', 'Turn on “Let phones play from this computer” in nexttupp on the computer, under Account, then try again.', null)
    }
    const code = req.query.code ?? ''
    if (!HANDOFF_CODE.test(code)) return sendPage(reply, 400, 'That link isn’t complete', 'Go back to nexttupp.com/watch and tap Connect again.')
    if (!allow()) return sendPage(reply, 429, 'Too many tries', 'Wait a minute, then tap Connect on nexttupp.com/watch again.')
    try {
      await account.redeemHandoff(code, lan.store.deviceId)
    } catch (err) {
      const offline = err instanceof CloudError && err.status === 0
      req.log.info({ handoff: err instanceof CloudError ? err.code : (err as Error).message }, 'phone handoff refused')
      return offline
        ? sendPage(reply, 503, 'This computer can’t reach nexttupp', 'It needs the internet for a moment to check your sign-in. Check its connection, then try again.')
        : sendPage(reply, 401, 'That link has expired', 'Links from nexttupp.com work once, for a minute. Go back and tap Connect again.')
    }
    if (!lan.store.verify(req.headers.cookie)) {
      const { token, client } = lan.store.add(clientLabel(req.headers['user-agent']))
      reply.header('set-cookie', `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`)
      req.log.info({ lanClient: client.label }, 'phone connected')
    }
    return reply.code(303).headers({ location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).send()
  })

  // PATCH and DELETE can't be sent cross-site without a preflight, which fails; the checks are belt and braces.
  const localOnly = (req: FastifyRequest, json = true) => {
    if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(403, 'Change this on the computer that runs nexttupp.')
    if (json && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Not allowed from another site')
  }

  const status = (req: FastifyRequest) => ({
    local: isLoopback(req.socket.remoteAddress),
    signedIn: account.signedIn(),
    enabled: lan.store.enabled !== false,
    phonesEnabled: lan.phonesEnabled(),
    listening: lan.listening,
    name: lan.name(),
    defaultName: defaultDeviceName(),
    urls: lan.urls(),
    clients: lan.clients().map(c => ({ ...c, current: c.id === req.lanClient?.id })),
  })

  app.get('/api/lan', async req => status(req))

  app.patch<{ Body: { enabled?: unknown; name?: unknown } }>('/api/lan', async req => {
    localOnly(req)
    const b = req.body ?? {}
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false')
    let name: string | null | undefined
    if (b.name !== undefined) {
      const raw = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : ''
      try { name = raw ? plainText(raw, 'name', 40) : null } catch { throw new HttpError(400, 'Use a name of 1 to 40 characters, like “Living room laptop”.') }
    }
    if (typeof b.enabled === 'boolean') lan.store.setEnabled(b.enabled)
    if (name !== undefined) lan.store.setName(name === defaultDeviceName() ? null : name)
    await lan.refresh()
    account.nudge()
    return status(req)
  })

  app.delete<{ Params: { id: string } }>('/api/lan/clients/:id', async (req, reply) => {
    localOnly(req, false)
    if (!lan.store.remove(req.params.id)) throw new HttpError(404, 'Not found')
    return reply.code(204).send()
  })
}
