// The two pages a link can open: /join#<invite token> (create an account) and /reset#<reset token>
// (set a new password). Tokens travel in the fragment, so they never reach logs or Referer headers.
// Everything else happens in the nexttupp app.

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
  <label>Password (8+ characters)<input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
  <button>Create account</button></form>`)

export const resetPage = () => page('Set a new password', `<form id="reset" novalidate>
  <label>New password (8+ characters)<input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></label>
  <button>Save password</button></form>`)

const SCRIPT = `(() => {
  const form = document.querySelector('form')
  const msg = document.getElementById('msg')
  const token = location.hash.slice(1)
  history.replaceState(null, '', location.pathname)
  const say = (text, err) => { msg.textContent = text; msg.className = err ? 'err' : '' }
  if (!token) { say('This link is incomplete. Open the full link you were sent.', true); form.hidden = true; return }
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    if (data.displayName === '') delete data.displayName
    const join = form.id === 'join'
    form.querySelector('button').disabled = true
    say('…')
    try {
      const res = await fetch(join ? '/v1/invites/accept' : '/v1/auth/reset', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...data }),
      })
      if (res.ok) {
        form.hidden = true
        say(join ? 'Account created. Sign in to the nexttupp app with ' + data.email + '.' : 'Password saved. Sign in to the nexttupp app with it.')
        return
      }
      const body = await res.json().catch(() => ({}))
      say(body.message || 'Something went wrong (' + res.status + ')', true)
    } catch { say('Could not reach the server. Try again.', true) }
    form.querySelector('button').disabled = false
  })
})()`

export const appScript = () => new Response(SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...HEADERS, 'cache-control': 'public, max-age=300' } })
