import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { AiError } from './providers.ts'

// Sign in with ChatGPT, the route OpenAI offers open-source and locally hosted apps: the person signs in in
// their browser and lets nexttupp use their ChatGPT plan (Plus/Pro) for Responses API requests. No API key,
// no client secret, no billing set-up. OAuth 2.0 authorisation code + PKCE + OpenID Connect, with dynamic
// client registration on the first sign-in. https://developers.openai.com/siwc/token-sharing-open-source

const AUTH = 'https://auth.openai.com'
const AUTHORIZE = `${AUTH}/api/accounts/authorize`
const TOKEN = `${AUTH}/api/accounts/oauth/token`
const RESOURCE = 'https://api.openai.com/v1'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
/** Only the port may differ between sign-ins: the host must be 127.0.0.1 and the path exactly this. */
export const CALLBACK_PATH = '/auth/callback'
const PENDING_MS = 10 * 60_000
/** Refresh this long before the hour-long access token runs out. */
const REFRESH_MARGIN_MS = 5 * 60_000

export interface ChatgptSession {
  clientId: string
  sub: string
  email: string
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  connectedAt: number
}

interface Pending { state: string; nonce: string; verifier: string; redirectUri: string; clientId: string | null; at: number }

type Fetch = typeof fetch

const b64url = (b: Buffer) => b.toString('base64url')

/** A host id for `ext_agent_host_id`: chosen once per computer, kept with the credentials. */
export const newHostId = () => `urn:uuid:${randomUUID()}`

export class ChatgptAuth {
  private pending: Pending | null = null
  private readonly fetch: Fetch
  private readonly now: () => number
  private config: { jwks_uri: string; revocation_endpoint?: string; issuer?: string } | null = null

  constructor (deps: { fetch?: Fetch; now?: () => number } = {}) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  get signingIn (): boolean { return this.pending !== null && this.now() - this.pending.at < PENDING_MS }

  cancel (): void { this.pending = null }

  /** The URL to open in the browser. `previous` re-signs into the same registration (same issued client id). */
  start (redirectUri: string, hostId: string, previous: { clientId: string; email?: string; idToken?: string } | null): string {
    const verifier = b64url(randomBytes(32))
    this.pending = { state: b64url(randomBytes(16)), nonce: b64url(randomBytes(16)), verifier, redirectUri, clientId: previous?.clientId ?? null, at: this.now() }
    const q = new URLSearchParams({
      client_id: previous?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state: this.pending.state,
      nonce: this.pending.nonce,
      code_challenge_method: 'S256',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    })
    if (!previous) q.set('agent_name_hint', 'nexttupp')
    if (previous?.idToken) q.set('id_token_hint', previous.idToken)
    if (previous?.email) q.set('login_hint', previous.email)
    return `${AUTHORIZE}?${q}`
  }

  /** Handles the browser's return to CALLBACK_PATH. Returns the new session, or throws an AiError to show. */
  async finish (query: Record<string, string | undefined>): Promise<ChatgptSession> {
    const p = this.pending
    if (!p || !this.signingIn || !query.state || query.state !== p.state) {
      throw new AiError('auth', 'This sign-in link has expired or was already used. Start again from AI settings in nexttupp.')
    }
    this.pending = null
    if (query.error) {
      throw new AiError('auth', query.error === 'access_denied' ? 'Sign-in was cancelled, so nothing changed.' : `ChatGPT sign-in failed (${query.error}).`)
    }
    const clientId = query.client_id ?? p.clientId
    if (!query.code || !clientId) throw new AiError('auth', 'ChatGPT didn’t send back a sign-in code. Try again.')
    if (p.clientId && query.client_id && query.client_id !== p.clientId) throw new AiError('auth', 'ChatGPT answered for a different app registration. Try again.')
    const tokens = await this.token({ grant_type: 'authorization_code', client_id: clientId, code: query.code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE })
    const scopes = String(tokens.scope ?? query.scope ?? '').split(/\s+/).filter(Boolean)
    if (!scopes.includes(PLAN_SCOPE)) {
      throw new AiError('auth', 'Signed in, but use of your ChatGPT plan wasn’t allowed, so nexttupp can’t ask ChatGPT anything. Sign in again and allow it, or use an API key instead.')
    }
    const who = await this.verifyIdToken(String(tokens.id_token ?? ''), clientId, p.nonce)
    return {
      clientId, sub: who.sub, email: who.email, idToken: String(tokens.id_token), accessToken: String(tokens.access_token),
      refreshToken: String(tokens.refresh_token ?? ''), expiresAt: this.now() + Number(tokens.expires_in ?? 3600) * 1000, scopes, connectedAt: this.now(),
    }
  }

  needsRefresh (s: ChatgptSession): boolean { return s.expiresAt - REFRESH_MARGIN_MS < this.now() }

  /** A new access token (and the replacement refresh token, which rotates). */
  async refresh (s: ChatgptSession): Promise<ChatgptSession> {
    if (!s.refreshToken) throw new AiError('auth', 'ChatGPT signed nexttupp out. Sign in with ChatGPT again in AI settings.')
    const t = await this.token({ grant_type: 'refresh_token', client_id: s.clientId, refresh_token: s.refreshToken, resource: RESOURCE })
    return {
      ...s,
      accessToken: String(t.access_token),
      refreshToken: String(t.refresh_token ?? s.refreshToken),
      idToken: t.id_token ? String(t.id_token) : s.idToken,
      expiresAt: this.now() + Number(t.expires_in ?? 3600) * 1000,
      scopes: t.scope ? String(t.scope).split(/\s+/).filter(Boolean) : s.scopes,
    }
  }

  /** Ends the session at OpenAI too. False when that couldn't be confirmed (the local copy is cleared anyway). */
  async revoke (s: ChatgptSession): Promise<boolean> {
    try {
      const conf = await this.openidConfig()
      if (!conf.revocation_endpoint) return false
      const res = await this.fetch(conf.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.clientId }),
        signal: AbortSignal.timeout(15_000),
      })
      return res.ok
    } catch { return false }
  }

  private async token (form: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await this.fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) })
    } catch { throw new AiError('network', 'Couldn’t reach ChatGPT to sign in. Check the internet connection.') }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (res.ok && body.access_token) return body
    const code = String(body.error ?? res.status)
    if (form.grant_type === 'refresh_token' && res.status >= 400 && res.status < 500) {
      throw new AiError('auth', 'ChatGPT signed nexttupp out. Sign in with ChatGPT again in AI settings.')
    }
    if (res.status >= 500) throw new AiError('busy', 'ChatGPT sign-in is having trouble right now. Try again in a few minutes.')
    throw new AiError('auth', `ChatGPT sign-in failed (${code}). Try again.`)
  }

  private async openidConfig (): Promise<{ jwks_uri: string; revocation_endpoint?: string; issuer?: string }> {
    if (!this.config) {
      const res = await this.fetch(`${AUTH}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new AiError('network', 'Couldn’t reach ChatGPT to check the sign-in.')
      this.config = await res.json() as { jwks_uri: string; revocation_endpoint?: string; issuer?: string }
    }
    return this.config
  }

  /** Signature (OpenAI's published keys), issuer, audience, expiry and nonce. Returns who signed in. */
  private async verifyIdToken (idToken: string, clientId: string, nonce: string): Promise<{ sub: string; email: string }> {
    const fail = () => new AiError('auth', 'ChatGPT’s sign-in reply didn’t check out. Try again.')
    const [h, p, sig] = idToken.split('.')
    if (!h || !p || !sig) throw fail()
    let header: { alg?: string; kid?: string }
    let claims: { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string }
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString())
      claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    } catch { throw fail() }
    const conf = await this.openidConfig()
    const res = await this.fetch(conf.jwks_uri, { signal: AbortSignal.timeout(15_000) })
    const jwks = await res.json().catch(() => ({ keys: [] })) as { keys: Array<Record<string, unknown> & { kid?: string }> }
    const jwk = jwks.keys.find(k => k.kid === header.kid)
    if (!jwk) throw fail()
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
    const data = Buffer.from(`${h}.${p}`)
    const signature = Buffer.from(sig, 'base64url')
    const ok = header.alg === 'RS256' ? verify('RSA-SHA256', data, key, signature)
      : header.alg === 'ES256' ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
      : false
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!ok || claims.iss !== (conf.issuer ?? AUTH) || !aud.includes(clientId) || !claims.exp || claims.exp * 1000 < this.now() - 60_000 || claims.nonce !== nonce || !claims.sub) throw fail()
    return { sub: claims.sub, email: claims.email ?? '' }
  }
}
