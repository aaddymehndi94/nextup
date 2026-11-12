// Signing in to the nexttupp API from the website, and creating an account (/account and /watch).
//
// The pages talk only to the nexttupp API (CORS, bearer token kept in this site's localStorage, so signing
// in on one page signs in on the others). The password never leaves the page: it is stretched here with
// PBKDF2-SHA256 (600,000 rounds, as in the app) and only the derived key is sent. An account made here is the
// same as one made in the app: same salt size, same rounds, same key.

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)

/** The API. On a local preview (`wrangler dev`) it is the local Worker, or ?api=http://127.0.0.1:<port>. */
function apiBase () {
  if (!LOCAL) return 'https://api.nexttupp.com'
  const asked = new URLSearchParams(location.search).get('api')
  return asked && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(asked) ? asked : 'http://127.0.0.1:8799'
}
const API = apiBase()
const STORE = 'nexttupp:cloud'
const KDF_ITERATIONS = 600000 // cloud/src/crypto.ts; the API refuses sign-ups with any other number

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

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0))

async function deriveKey (password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations }, base, 256)
  return b64url(new Uint8Array(bits))
}

async function loginWithKey (email, key) {
  const r = await api('POST', '/v1/auth/login', { email, key })
  session = { api: API, token: r.token, expiresAt: r.expiresAt, email: r.account.email }
  saveSession(session)
}

async function signIn (email, password) {
  session = null
  const pre = await api('POST', '/v1/auth/prelogin', { email })
  if (pre.kdf !== 'pbkdf2-sha256' || !Number.isInteger(pre.iterations) || pre.iterations < 100000 || pre.iterations > 5000000) {
    throw new ApiError(400, 'unsupported_kdf', 'This page can’t sign in to this account. Try again later.')
  }
  await loginWithKey(email, await deriveKey(password, pre.salt, pre.iterations))
}

async function signUp (email, password, displayName) {
  session = null
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)))
  const key = await deriveKey(password, salt, KDF_ITERATIONS)
  const body = { email, salt, iterations: KDF_ITERATIONS, key }
  if (displayName) body.displayName = displayName
  await api('POST', '/v1/auth/signup', body)
  await loginWithKey(email, key)
}

export async function signOut () {
  try { await api('POST', '/v1/auth/logout') } catch { /* already gone, or offline: forget it here anyway */ }
  forgetSession()
}

// ---- The sign-in / create-account form -----------------------------------------------------

const FORM = `
  <div class="auth-tabs" role="group" aria-label="Sign in or create an account">
    <button type="button" data-mode="signin">Sign in</button>
    <button type="button" data-mode="create">Create account</button>
  </div>
  <form class="watch-form" novalidate>
    <label class="watch-field">
      <span>Email</span>
      <input type="email" name="email" autocomplete="username" inputmode="email" spellcheck="false" autocapitalize="off" required>
    </label>
    <label class="watch-field">
      <span data-pw-label>Password</span>
      <span class="pw">
        <input type="password" name="password" autocomplete="current-password" required>
        <button type="button" class="pw-show" data-pw-show aria-pressed="false">Show</button>
      </span>
    </label>
    <label class="watch-field" data-name-field hidden>
      <span>Your name <em>(optional)</em></span>
      <input name="displayName" autocomplete="nickname" maxlength="40">
    </label>
    <p class="watch-error" role="alert" data-error></p>
    <button class="button primary large" type="submit" data-submit>Sign in</button>
  </form>
  <p class="auth-switch" data-switch></p>`

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The API's messages, in plain words where its own are written for developers. */
function friendly (err) {
  if (err.code === 'invalid_credentials') return 'Wrong email or password.'
  if (err.status === 400 && /^email/.test(err.message)) return 'That email doesn’t look right. Check it and try again.'
  if (err.status === 400 && /^displayName/.test(err.message)) return 'That name can’t be used. Try a plain first name, or leave it empty.'
  return err.message
}

/**
 * Puts the sign-in / create-account form into `root`. Calls `onSignedIn()` once signed in, and `onMode(mode)`
 * when the visitor switches between 'signin' and 'create'. `path` is this page, for the "open it over https"
 * hint. Returns `{ setError, setMode }`.
 */
export function mountAuth (root, { onSignedIn, onMode = () => {}, path, mode: start = 'signin' }) {
  root.innerHTML = FORM
  const form = root.querySelector('form')
  const errorLine = root.querySelector('[data-error]')
  const submit = root.querySelector('[data-submit]')
  const nameField = root.querySelector('[data-name-field]')
  const pwLabel = root.querySelector('[data-pw-label]')
  const pwShow = root.querySelector('[data-pw-show]')
  const switchLine = root.querySelector('[data-switch]')
  let mode = start
  let busy = false

  const label = () => mode === 'create' ? 'Create my account' : 'Sign in'

  function setMode (next, { keepError = false } = {}) {
    mode = next
    for (const b of root.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
    nameField.hidden = mode !== 'create'
    pwLabel.textContent = mode === 'create' ? 'Choose a password (8 or more characters)' : 'Password'
    form.password.autocomplete = mode === 'create' ? 'new-password' : 'current-password'
    if (!busy) submit.textContent = label()
    switchLine.replaceChildren()
    const other = document.createElement('button')
    other.type = 'button'
    other.className = 'link'
    other.textContent = mode === 'create' ? 'Sign in' : 'Create a free account'
    other.addEventListener('click', () => { setMode(mode === 'create' ? 'signin' : 'create'); form.email.focus() })
    switchLine.append(mode === 'create' ? 'Already have an account? ' : 'New to nexttupp? ', other)
    if (!keepError) errorLine.textContent = ''
    onMode(mode)
  }

  for (const b of root.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode))
  // An old error goes away as soon as the visitor starts fixing it.
  form.addEventListener('input', () => { if (!busy) errorLine.textContent = '' })

  pwShow.addEventListener('click', () => {
    const show = form.password.type === 'password'
    form.password.type = show ? 'text' : 'password'
    pwShow.textContent = show ? 'Hide' : 'Show'
    pwShow.setAttribute('aria-pressed', String(show))
  })

  form.addEventListener('submit', async e => {
    e.preventDefault()
    if (busy) return
    const email = form.email.value.trim()
    const password = form.password.value
    const name = form.displayName.value.trim()
    errorLine.textContent = ''
    if (!email || !password) { errorLine.textContent = 'Enter your email and password.'; return }
    if (mode === 'create' && !EMAIL.test(email)) { errorLine.textContent = 'That email doesn’t look right. Check it and try again.'; return }
    if (mode === 'create' && [...password].length < 8) { errorLine.textContent = 'Choose a password with 8 or more characters.'; return }
    if (!crypto.subtle) { errorLine.textContent = `This browser can’t sign in securely here. Open https://nexttupp.com${path}.`; return }
    busy = true
    submit.disabled = true
    submit.textContent = mode === 'create' ? 'Creating your account…' : 'Signing in…'
    try {
      if (mode === 'create') await signUp(email, password, name)
      else await signIn(email, password)
      form.reset()
      onSignedIn()
    } catch (err) {
      if (err.code === 'email_taken') {
        setMode('signin', { keepError: true })
        errorLine.textContent = 'You already have an account with that email. Enter its password to sign in.'
        form.password.value = ''
        form.password.focus()
      } else {
        errorLine.textContent = friendly(err)
      }
    } finally {
      busy = false
      submit.disabled = false
      submit.textContent = label()
    }
  })

  setMode(start)
  return { setError: message => { errorLine.textContent = message || '' }, setMode }
}
