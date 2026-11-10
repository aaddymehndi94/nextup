// The two pages a link can open: /join?code=<invite code> (create an account) and /reset#<reset token>
// (set a new password). Invite links normally open the website (<PUBLIC_URL>/join?code=…); this /join is
// the fallback, and it also takes the code in the fragment (older links). Both pages stretch the password
// in the browser with WebCrypto PBKDF2 and send only the derived key (see crypto.ts). Everything else
// happens in the nexttupp app.

import { KDF_ITERATIONS } from './crypto.ts'

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

const HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
}

function page (title: string, form: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · nexttupp</title>
<style>
  :root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #0e0e10; color: #ececf0; }
  main { max-width: 22rem; margin: 12vh auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  label { display: block; margin: 0 0 1rem; font-size: .875rem; color: #a8a8b3; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: .25rem; padding: .6rem .7rem; border-radius: .5rem;
          border: 1px solid #33333a; background: #17171b; color: inherit; font: inherit; }
  button { width: 100%; padding: .7rem; border: 0; border-radius: .5rem; background: #ececf0; color: #0e0e10; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #msg { min-height: 1.5rem; margin-top: 1rem; }
  .err { color: #ff8a80; }
</style></head>
<body><main><h1>${title}</h1>${form}<p id="msg" role="status"></p></main><script src="/app.js"></script></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...HEADERS } })
}

export const joinPage = () => page('Join nexttupp', `<form id="join" novalidate>
  <label>Email<input name="email" type="email" autocomplete="email" required></label>
  <label>Name (optional)<input name="displayName" maxlength="40" autocomplete="nickname"></label>
  <label>Password (8+ characters)<input name="password" type="password" minlength="8" maxlength="256" autocomplete="new-password" required></label>
  <button>Create account</button></form>`)

export const resetPage = () => page('Set a new password', `<form id="reset" novalidate>
  <label>New password (8+ characters)<input name="password" type="password" minlength="8" maxlength="256" autocomplete="new-password" required></label>
  <button>Save password</button></form>`)

const SCRIPT = `(() => {
  const ITERATIONS = ${KDF_ITERATIONS}
  const form = document.querySelector('form')
  const msg = document.getElementById('msg')
  const token = new URLSearchParams(location.search).get('code') || location.hash.slice(1)
  history.replaceState(null, '', location.pathname)
  const say = (text, err) => { msg.textContent = text; msg.className = err ? 'err' : '' }
  if (!token) { say('This link is incomplete. Open the full link you were sent.', true); form.hidden = true; return }
  const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  // The password never leaves this page: only PBKDF2-SHA256(NFC(password) as UTF-8, salt, ITERATIONS) is sent.
  async function derive (password, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 256))
  }
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    const join = form.id === 'join'
    const chars = [...data.password].length
    if (chars < 8 || chars > 256 || !data.password.trim()) { say('Use a password of 8 to 256 characters.', true); return }
    form.querySelector('button').disabled = true
    say('Securing your password…')
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const cred = { salt: b64url(salt), iterations: ITERATIONS, key: b64url(await derive(data.password, salt)) }
      const body = join
        ? { token, email: data.email, ...(data.displayName ? { displayName: data.displayName } : {}), ...cred }
        : { token, ...cred }
      const res = await fetch(join ? '/v1/invites/accept' : '/v1/auth/reset', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      if (res.ok) {
        form.hidden = true
        say(join ? 'Account created. Sign in to the nexttupp app with ' + data.email + '.' : 'Password saved. Sign in to the nexttupp app with it.')
        return
      }
      const err = await res.json().catch(() => ({}))
      say(err.message || 'Something went wrong (' + res.status + ')', true)
    } catch { say('Could not reach the server. Try again.', true) }
    form.querySelector('button').disabled = false
  })
})()`

export const appScript = () => new Response(SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...HEADERS, 'cache-control': 'public, max-age=300' } })
