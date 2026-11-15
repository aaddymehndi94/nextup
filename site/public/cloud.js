// Signing in to the nexttupp API from the website (/account and /watch), which also creates the account the
// first time: "Continue with Google". No password.
//
// The pages talk only to the nexttupp API (CORS, bearer token kept in this site's localStorage, so signing
// in on one page signs in on the others). An account made here is the same as one made in the app.

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
    throw new ApiError(0, 'offline', 'Can’t reach nexttupp. Check your internet connection and try again.')
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error || 'error', data.message || `Something went wrong (${res.status}). Try again.`)
  return data
}

/**
 * Google sends the browser back with a one-time ticket, which only the secret this tab kept can turn into a
 * session (the cloud got only its SHA-256, the challenge).
 */
async function redeem (ticket, secret) {
  session = null
  const r = await api('POST', '/v1/auth/ticket', { ticket, secret })
  session = { api: API, token: r.token, expiresAt: r.expiresAt, email: r.account.email }
  saveSession(session)
  return r
}

export async function signOut () {
  try { await api('POST', '/v1/auth/logout') } catch { /* already gone, or offline: forget it here anyway */ }
  forgetSession()
}

// ---- The sign-in button: Continue with Google ----------------------------------------------

const GOOGLE_MARK = `<svg class="google-mark" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`

const FORM = `
  <div class="watch-form">
    <p class="watch-error" role="alert" data-error></p>
    <button class="button google large" type="button" data-google>${GOOGLE_MARK}<span data-label>Continue with Google</span></button>
    <p class="auth-terms">By continuing, you agree to the <a class="link" href="/terms">terms</a>.</p>
  </div>`

const SECRET = 'nexttupp:google-secret'
/** The pages that sign in; Google brings the browser back to the one it left from. */
const PAGES = ['/account', '/watch']

/** What went wrong, in plain words: the #error Google's round trip came back with, or the API's error. */
const WHY = {
  cancelled: 'Sign-in was cancelled. Nothing changed.',
  expired: 'That sign-in took too long. Try again.',
  unverified_email: 'Google hasn’t confirmed that email yet. Use a Google account whose email is confirmed.',
  account_disabled: 'This account has been disabled.',
  too_many_attempts: 'Too many new accounts from this network. Try again in an hour.',
  google_failed: 'Google didn’t sign you in. Try again.',
  invalid_ticket: 'That sign-in didn’t finish. Try again.',
  google_unavailable: 'Signing in with Google isn’t available right now. Try again later.',
}
const friendly = err => WHY[err.code] ?? err.message

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Puts "Continue with Google" into `root`. The same button signs in and creates an account; `mode` ('signin' or
 * 'create') only lets the page word its heading (`onMode(mode)`). Coming back from Google, it finishes signing
 * in by itself and calls `onSignedIn()`. Returns `{ setError, setMode }`.
 */
export function mountAuth (root, { onSignedIn, onMode = () => {}, mode = 'signin' }) {
  root.innerHTML = FORM
  const error = root.querySelector('[data-error]')
  const button = root.querySelector('[data-google]')
  const label = root.querySelector('[data-label]')
  const mark = root.querySelector('.google-mark')
  const spinner = Object.assign(document.createElement('span'), { className: 'spinner' })
  spinner.setAttribute('aria-hidden', 'true')
  const busy = text => {
    button.disabled = Boolean(text)
    label.textContent = text || 'Continue with Google'
    if (text) mark.replaceWith(spinner); else spinner.replaceWith(mark) // each a no-op when already so
  }
  // Back from Google with the browser's Back button, the page may come back as it was left: busy.
  addEventListener('pageshow', e => { if (e.persisted) busy('') })

  button.addEventListener('click', async () => {
    busy('Opening Google…')
    error.textContent = ''
    const secret = b64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
    try { sessionStorage.setItem(SECRET, secret) } catch { /* the ticket can't be used without it: say so below */ }
    const back = PAGES.includes(location.pathname) ? location.pathname : '/account'
    location.assign(`${API}/v1/auth/google?${new URLSearchParams({ to: 'site', back, challenge })}`)
  })

  // Back from Google: #ticket=… (or #error=…), used once and cleared from the address bar straight away.
  const hash = new URLSearchParams(location.hash.slice(1))
  if (hash.has('ticket') || hash.has('error')) {
    history.replaceState(null, '', location.pathname + location.search)
    let secret = null
    try { secret = sessionStorage.getItem(SECRET); sessionStorage.removeItem(SECRET) } catch { /* below */ }
    if (hash.has('error')) error.textContent = WHY[hash.get('error')] ?? WHY.google_failed
    else if (!secret) error.textContent = 'That sign-in started in another tab or browser. Try again here.'
    else {
      busy('Signing you in…')
      redeem(hash.get('ticket'), secret)
        .then(() => onSignedIn(), err => { error.textContent = friendly(err) })
        .finally(() => busy(''))
    }
  }

  onMode(mode)
  return {
    setError: message => { error.textContent = message || '' },
    setMode: next => { onMode(next) },
  }
}
