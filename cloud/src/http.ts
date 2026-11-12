// A small router, JSON helpers and errors. Every error leaves as `{ error: <code>, message }`.

import { bad, HttpError } from './errors.ts'

export { bad, HttpError }

export interface Env {
  DB: D1Database
}


const CORS: Record<string, string> = {
  // Bearer tokens only, no cookies, so any origin (the desktop app's webview) may call the API.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

const SECURITY: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

export function json (body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...SECURITY, ...headers } })
}

export function empty (status = 204): Response {
  return new Response(null, { status, headers: { ...CORS, ...SECURITY } })
}

export function errorResponse (err: HttpError): Response {
  return json({ error: err.code, message: err.message }, err.status, err.headers)
}

export function preflight (): Response {
  return new Response(null, { status: 204, headers: CORS })
}

/** Reads a JSON object body of at most `maxBytes`, whatever the Content-Length claims. */
export async function readJson (req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type') ?? ''
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Send Content-Type: application/json')
  const declared = Number(req.headers.get('content-length') ?? NaN)
  if (declared > maxBytes) throw tooLarge(maxBytes)
  if (!req.body) throw bad('Request body is empty')
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel(); throw tooLarge(maxBytes) }
    chunks.push(value)
  }
  const buf = new Uint8Array(size)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf))
  } catch {
    throw bad('Body is not valid JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object')
  return body as Record<string, unknown>
}

function tooLarge (max: number): HttpError {
  return new HttpError(413, 'too_large', `Body is larger than ${max} bytes`)
}

/** Rejects any key not in `allowed`, so clients can't park extra data in a request. */
export function onlyKeys (o: Record<string, unknown>, allowed: string[], where = 'body'): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(`${where}: unknown field "${k}"`)
}

export interface Ctx {
  req: Request
  env: Env
  url: URL
  params: string[]
  now: number
}

type Handler = (ctx: Ctx) => Promise<Response>

export class Router {
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = []

  on (method: string, path: string, handler: Handler): this {
    // `:name` segments capture one path segment, in order.
    const pattern = new RegExp(`^${path.replace(/:[a-z]+/gi, '([^/]+)')}$`)
    this.routes.push({ method, pattern, handler })
    return this
  }

  async handle (req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return preflight()
    let pathMatched = false
    for (const r of this.routes) {
      const m = r.pattern.exec(url.pathname)
      if (!m) continue
      pathMatched = true
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue
      try {
        const params = m.slice(1).map(p => { try { return decodeURIComponent(p) } catch { throw bad('Bad path') } })
        return await r.handler({ req, env, url, params, now: Date.now() })
      } catch (err) {
        if (err instanceof HttpError) return errorResponse(err)
        console.error(`${req.method} ${url.pathname}:`, err instanceof Error ? err.stack ?? err.message : err)
        return errorResponse(new HttpError(500, 'internal', 'Something went wrong'))
      }
    }
    return errorResponse(pathMatched ? new HttpError(405, 'method_not_allowed', 'Method not allowed') : new HttpError(404, 'not_found', 'Not found'))
  }
}
