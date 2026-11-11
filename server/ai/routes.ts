import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AiKeyRequest, AiPicksResponse, AiProvider, AiSearchRequest, AiSearchResponse, AiSettingsRequest, AiSignInResponse, AiStatus } from '../../shared/types.ts'
import { HttpError } from '../http.ts'
import { isLoopback } from '../lan/net.ts'
import { hasPrivateHeader } from '../private.ts'
import type { TasteStore } from '../store.ts'
import { profileFrom } from '../taste/routes.ts'
import { CALLBACK_PATH } from './chatgpt.ts'
import { AiError } from './providers.ts'
import type { AiService } from './service.ts'

//   GET    /api/ai                 AiStatus (connections, models, the active model, usage)
//   PUT    /api/ai/key             { provider, key }: check the key and connect          (this computer only)
//   PATCH  /api/ai                 { choice?, dailyLimit? }                               (this computer only)
//   POST   /api/ai/chatgpt         { url }: open it to sign in with ChatGPT               (this computer only)
//   GET    /auth/callback          where ChatGPT sends the browser back (fixed path, 127.0.0.1 only)
//   DELETE /api/ai/:provider       disconnect                                             (this computer only)
//   GET    /api/ai/picks           the profile's saved AI picks (never asks a model)
//   POST   /api/ai/picks           ask for new picks
//   POST   /api/ai/search          { q, refresh? }: answer from the saved search or ask
// Phones and TVs at home can use AI (the computer's connection) but not change it. Private mode doesn't use it.

const PROVIDERS: AiProvider[] = ['chatgpt', 'anthropic', 'openai']
const LIMITS = [0, 10, 20, 50, 100, 200]

export function registerAiRoutes (app: FastifyInstance, ai: AiService, store: TasteStore, opts: { port: () => number }): void {
  const local = (req: FastifyRequest) => isLoopback(req.socket.remoteAddress)
  const localOnly = (req: FastifyRequest) => {
    if (!local(req)) throw new HttpError(403, 'Change AI settings on the computer that runs nexttupp.')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Not allowed from another site')
  }
  const notPrivate = (req: FastifyRequest) => {
    if (hasPrivateHeader(req)) throw new HttpError(409, 'AI is off in private mode: it would send what you search for to the AI provider.')
  }

  app.get('/api/ai', async (req): Promise<AiStatus> => ai.status(local(req)))

  app.put<{ Body: AiKeyRequest }>('/api/ai/key', async (req): Promise<AiStatus> => {
    localOnly(req)
    const { provider, key } = req.body ?? {} as AiKeyRequest
    if (provider !== 'anthropic' && provider !== 'openai') throw new HttpError(400, 'Unknown provider')
    const k = typeof key === 'string' ? key.trim() : ''
    if (!/^[\w-]{20,300}$/.test(k)) throw new HttpError(400, 'That doesn’t look like an API key. Copy the whole key and paste it again.')
    if (provider === 'anthropic' && !k.startsWith('sk-ant-')) throw new HttpError(400, 'Claude API keys start with sk-ant-. Make one at platform.claude.com, under API keys.')
    if (provider === 'openai' && (!k.startsWith('sk-') || k.startsWith('sk-ant-'))) throw new HttpError(400, 'OpenAI API keys start with sk-. Make one at platform.openai.com, under API keys.')
    await ai.connectKey(provider, k)
    return ai.status(true)
  })

  app.patch<{ Body: AiSettingsRequest }>('/api/ai', async (req): Promise<AiStatus> => {
    localOnly(req)
    const b = req.body ?? {}
    if (b.choice !== undefined && b.choice !== null && (typeof b.choice !== 'string' || !ai.models().some(m => m.id === b.choice))) throw new HttpError(400, 'Unknown model')
    if (b.dailyLimit !== undefined && !LIMITS.includes(b.dailyLimit)) throw new HttpError(400, `Daily limit must be one of ${LIMITS.join(', ')}`)
    ai.settings(b)
    return ai.status(true)
  })

  app.post('/api/ai/chatgpt', async (req): Promise<AiSignInResponse> => {
    localOnly(req)
    // OpenAI accepts a loopback redirect to 127.0.0.1 on any port, with exactly this path.
    return { url: ai.chatgptSignIn(`http://127.0.0.1:${opts.port()}${CALLBACK_PATH}`) }
  })

  app.get<{ Querystring: Record<string, string | undefined> }>(CALLBACK_PATH, async (req, reply) => {
    if (!local(req)) throw new HttpError(403, 'Not here')
    try {
      await ai.chatgptCallback(req.query)
      return page(reply, 200, 'ChatGPT is connected', 'You can close this tab and go back to nexttupp. AI picks and Ask AI will use your ChatGPT plan.')
    } catch (err) {
      return page(reply, 400, 'ChatGPT isn’t connected', err instanceof AiError ? err.message : 'Something went wrong. Start again from AI settings in nexttupp.')
    }
  })

  app.delete<{ Params: { provider: string } }>('/api/ai/:provider', async (req): Promise<AiStatus & { revoked?: boolean }> => {
    localOnly(req)
    const p = req.params.provider as AiProvider
    if (!PROVIDERS.includes(p)) throw new HttpError(400, 'Unknown provider')
    const { revoked } = await ai.disconnect(p)
    return { ...ai.status(true), revoked }
  })

  app.get('/api/ai/picks', async (req): Promise<AiPicksResponse> => ai.picks(profileFrom(store, req), { private: hasPrivateHeader(req) }))

  app.post('/api/ai/picks', async (req): Promise<AiPicksResponse> => {
    notPrivate(req)
    return ai.makePicks(profileFrom(store, req))
  })

  app.post<{ Body: AiSearchRequest }>('/api/ai/search', async (req): Promise<AiSearchResponse> => {
    notPrivate(req)
    const q = typeof req.body?.q === 'string' ? req.body.q.trim() : ''
    if (q.length < 2 || q.length > 300) throw new HttpError(400, 'Type what you feel like watching (2 to 300 characters).')
    return ai.search(profileFrom(store, req), q, req.body?.refresh === true)
  })
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function page (reply: FastifyReply, status: number, title: string, message: string) {
  return reply.code(status).header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · nexttupp</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d10;color:#ececf1;font:16px/1.5 system-ui,sans-serif}main{max-width:28rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#a5a5b0;margin:0}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`)
}
