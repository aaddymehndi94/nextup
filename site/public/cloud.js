// Signing in to the nexttupp API from the website, shared by /watch and /invite.
//
// The page talks only to the nexttupp API (CORS, bearer token kept in this site's localStorage, so signing
// in on one page signs in on the other). The password never leaves the page: it is stretched here with
// PBKDF2-SHA256 (600,000 rounds, as in the app) and only the derived key is sent.

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)

/** The API. On a local preview (`wrangler dev`) it is the local Worker, or ?api=http://127.0.0.1:<port>. */
function apiBase () {
  if (!LOCAL) return 'https://api.nexttupp.com'
  const asked = new URLSearchParams(location.search).get('api')
  return asked && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(asked) ? asked : 'http://127.0.0.1:8799'
}
const API = apiBase()
const STORE = 'nexttupp:cloud'

function loadSession () {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null')
    return s && s.api === API && typeof s.token === 'string' && s.expiresAt > Date.now() ? s : null
  } catch { return null }
}
function saveSession (s) { try { localStorage.setItem(STORE, JSON.stringify(s)) } catch { /* private mode: this visit only */ } }

let session = loadSession()

/** The signed-in session ({ token, expiresAt, email }), or null. */
export const currentSession = () => session

export function forgetSession () {
  session = null
  try { localStorage.removeItem(STORE) } catch { /* unavailable */ }
}

export class ApiError extends Error {
  constructor (status, code, message) { super(message); this.status = status; this.code = code }
}

/** True for errors that mean "sign in again". */
export const signedOutError = err => err.status === 401 || err.code === 'account_disabled'

export async function api (method, path, body) {
  const headers = { accept: 'application/json' }
  if (session) headers.authorization = `Bearer ${session.token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' })
  } catch {
    throw new ApiError(0, 'offline', 'Can’t reach nexttupp. Check this phone’s connection.')
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error || 'error', data.message || `Something went wrong (${res.status}).`)
  return data
}

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0))

async function deriveKey (password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations }, base, 256)
  return b64url(new Uint8Array(bits))
}

async function signIn (email, password) {
  session = null
  const pre = await api('POST', '/v1/auth/prelogin', { email })
  if (pre.kdf !== 'pbkdf2-sha256' || !Number.isInteger(pre.iterations) || pre.iterations < 100000 || pre.iterations > 5000000) {
    throw new ApiError(400, 'unsupported_kdf', 'This page can’t sign in to this account. Try again later.')
  }
  const key = await deriveKey(password, pre.salt, pre.iterations)
  const r = await api('POST', '/v1/auth/login', { email, key })
  session = { api: API, token: r.token, expiresAt: r.expiresAt, email: r.account.email }
  saveSession(session)
}

export async function signOut () {
  try { await api('POST', '/v1/auth/logout') } catch { /* already gone, or offline: forget it here anyway */ }
  forgetSession()
}

/**
 * Wires a sign-in form (fields `email` and `password`, plus [data-error] and [data-submit] inside it or on
 * the page) to sign in and then call `onSignedIn`. `path` is this page, for the "open it over https" hint.
 */
export function wireSignIn (form, onSignedIn, path) {
  const errorLine = document.querySelector('[data-error]')
  const submit = document.querySelector('[data-submit]')
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const email = form.email.value.trim()
    const password = form.password.value
    errorLine.textContent = ''
    if (!email || !password) { errorLine.textContent = 'Enter your email and password.'; return }
    if (!crypto.subtle) { errorLine.textContent = `This browser can’t sign in securely here. Open https://nexttupp.com${path}.`; return }
    submit.disabled = true
    submit.textContent = 'Signing in…'
    try {
      await signIn(email, password)
      form.reset()
      onSignedIn()
    } catch (err) {
      errorLine.textContent = err.code === 'invalid_credentials' ? 'Wrong email or password.' : err.message
    } finally {
      submit.disabled = false
      submit.textContent = 'Sign in'
    }
  })
  return message => { errorLine.textContent = message || '' }
}
