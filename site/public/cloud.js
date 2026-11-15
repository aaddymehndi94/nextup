// Signing in to the nexttupp API from the website (/account and /watch), which also creates the account the
// first time: type an email, get a 6-digit code by email, type it in. No password.
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

/** Emails a code to `email`. Answers the same whether or not the email has an account. */
const sendCode = email => api('POST', '/v1/auth/code', { email })

/** Trades the code for a session; creates the account (with `displayName`) if there wasn't one. */
async function verifyCode (email, code, displayName) {
  session = null
  const body = { email, code }
  if (displayName) body.displayName = displayName
  const r = await api('POST', '/v1/auth/code/verify', body)
  session = { api: API, token: r.token, expiresAt: r.expiresAt, email: r.account.email }
  saveSession(session)
  return r
}

export async function signOut () {
  try { await api('POST', '/v1/auth/logout') } catch { /* already gone, or offline: forget it here anyway */ }
  forgetSession()
}

// ---- The sign-in form: email, then the code ------------------------------------------------

const FORM = `
  <form class="watch-form" data-step="email" novalidate>
    <label class="watch-field">
      <span>Email</span>
      <input type="email" name="email" autocomplete="email" inputmode="email" spellcheck="false" autocapitalize="off" required>
    </label>
    <label class="watch-field" data-name-field hidden>
      <span>Your name <em>(optional)</em></span>
      <input name="displayName" autocomplete="nickname" maxlength="40">
    </label>
    <p class="watch-error" role="alert" data-error></p>
    <button class="button primary large" type="submit" data-submit>Email me a code</button>
    <p class="auth-terms">By continuing, you agree to the <a class="link" href="/terms">terms</a>.</p>
  </form>
  <form class="watch-form" data-step="code" novalidate hidden>
    <p class="auth-sent" data-sent></p>
    <label class="watch-field">
      <span>Code</span>
      <input class="code-input" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" spellcheck="false" required>
    </label>
    <p class="watch-error" role="alert" data-error></p>
    <button class="button primary large" type="submit" data-submit>Continue</button>
    <p class="auth-switch" data-resend-line>Nothing yet? Check your spam folder, or <button type="button" class="link" data-resend>send a new code</button>.</p>
  </form>
  <p class="auth-switch" data-switch></p>`

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The API's messages, in plain words where its own are written for developers. */
function friendly (err) {
  if (err.status === 400 && /^email/.test(err.message)) return 'That email doesn’t look right. Check it and try again.'
  if (err.status === 400 && /^code/.test(err.message)) return 'The code is the 6 digits in the email.'
  if (err.status === 400 && /^displayName/.test(err.message)) return 'That name can’t be used. Try a plain first name, or leave it empty.'
  return err.message
}

/**
 * Puts the sign-in form into `root`: an email, then the code sent to it. The same form signs in and creates
 * an account; 'create' mode only adds the optional name, and `onMode(mode)` lets the page change its heading.
 * `onStep('email' | 'code')` says which step shows, so the page can drop an intro that no longer fits. Calls
 * `onSignedIn()` once signed in. Returns `{ setError, setMode }`.
 */
export function mountAuth (root, { onSignedIn, onMode = () => {}, onStep = () => {}, mode: start = 'signin' }) {
  root.innerHTML = FORM
  const emailForm = root.querySelector('[data-step="email"]')
  const codeForm = root.querySelector('[data-step="code"]')
  const nameField = root.querySelector('[data-name-field]')
  const switchLine = root.querySelector('[data-switch]')
  const sentLine = root.querySelector('[data-sent]')
  const resend = root.querySelector('[data-resend]')
  const errorOf = form => form.querySelector('[data-error]')
  const submitOf = form => form.querySelector('[data-submit]')
  let mode = start
  let email = ''
  let busy = false

  function setMode (next) {
    mode = next
    nameField.hidden = mode !== 'create'
    switchLine.replaceChildren()
    if (!codeForm.hidden) { onMode(mode); return }
    const other = document.createElement('button')
    other.type = 'button'
    other.className = 'link'
    other.textContent = mode === 'create' ? 'Sign in' : 'Create a free account'
    other.addEventListener('click', () => { setMode(mode === 'create' ? 'signin' : 'create'); emailForm.email.focus() })
    switchLine.append(mode === 'create' ? 'Already have an account? ' : 'New to nexttupp? ', other)
    onMode(mode)
  }

  function showEmail () {
    codeForm.hidden = true
    emailForm.hidden = false
    codeForm.reset()
    errorOf(codeForm).textContent = ''
    onStep('email')
    setMode(mode)
    emailForm.email.focus()
  }

  function showCode () {
    emailForm.hidden = true
    codeForm.hidden = false
    switchLine.replaceChildren()
    const other = document.createElement('button')
    other.type = 'button'
    other.className = 'link'
    other.textContent = 'Use a different email'
    other.addEventListener('click', showEmail)
    sentLine.replaceChildren('We sent a code to ', Object.assign(document.createElement('strong'), { textContent: email }), '. It works for 10 minutes.')
    switchLine.append(other)
    onStep('code')
    codeForm.code.focus()
  }

  async function run (form, busyLabel, work) {
    if (busy) return
    const submit = submitOf(form)
    const label = submit.textContent
    busy = true
    submit.disabled = true
    submit.textContent = busyLabel
    errorOf(form).textContent = ''
    try { await work() } catch (err) {
      errorOf(form).textContent = friendly(err)
      // A wrong code stays selected, so typing the right one replaces it.
      if (form === codeForm) codeForm.code.select()
    } finally {
      busy = false
      submit.disabled = false
      submit.textContent = label
    }
  }

  // An old error goes away as soon as the visitor starts fixing it.
  for (const form of [emailForm, codeForm]) form.addEventListener('input', () => { if (!busy) errorOf(form).textContent = '' })

  emailForm.addEventListener('submit', e => {
    e.preventDefault()
    const typed = emailForm.email.value.trim()
    if (!typed) { errorOf(emailForm).textContent = 'Enter your email.'; return }
    if (!EMAIL.test(typed)) { errorOf(emailForm).textContent = 'That email doesn’t look right. Check it and try again.'; return }
    void run(emailForm, 'Sending your code…', async () => {
      await sendCode(typed)
      email = typed
      showCode()
    })
  })

  const digits = () => codeForm.code.value.replace(/\D/g, '')
  const verify = () => run(codeForm, 'Signing in…', async () => {
    await verifyCode(email, digits(), mode === 'create' ? emailForm.displayName.value.trim() : '')
    emailForm.reset()
    codeForm.reset()
    onSignedIn()
  })
  codeForm.addEventListener('submit', e => {
    e.preventDefault()
    if (digits().length !== 6) { errorOf(codeForm).textContent = 'The code is the 6 digits in the email.'; return }
    void verify()
  })
  // Digits only, six at most ("123 456" pastes as 123456). Six typed or pasted, or filled in from the email by the
  // phone: sign in straight away.
  codeForm.code.addEventListener('input', () => {
    const d = digits().slice(0, 6)
    if (codeForm.code.value !== d) codeForm.code.value = d
    if (d.length === 6 && !busy) void verify()
  })

  // Busy on the link itself, so Continue keeps its label. It stays: a code that ran out of tries needs another.
  resend.addEventListener('click', async () => {
    if (busy) return
    busy = true
    resend.disabled = true
    resend.textContent = 'sending…'
    errorOf(codeForm).textContent = ''
    try {
      await sendCode(email)
      codeForm.reset()
      sentLine.replaceChildren('We sent a new code to ', Object.assign(document.createElement('strong'), { textContent: email }), '. Use the newest one.')
      codeForm.code.focus()
    } catch (err) { errorOf(codeForm).textContent = friendly(err) } finally {
      busy = false
      resend.disabled = false
      resend.textContent = 'send a new code'
    }
  })

  setMode(start)
  return {
    setError: message => { errorOf(codeForm.hidden ? emailForm : codeForm).textContent = message || '' },
    setMode: next => { if (!codeForm.hidden) showEmail(); setMode(next) },
  }
}
