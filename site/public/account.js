// /account: sign in, or create an account, on the website. Once signed in, it shows what to do next: until a
// computer has signed in with this account, the three steps (get the app, sign in to it, watch); after that,
// the account's computers and, on a phone, the way to watch on it. Signing in and the session are in cloud.js;
// the download button is filled in by site.js.

import { api, currentSession, forgetSession, mountAuth, signedOutError, signOut } from './cloud.js'
import './site.js'

const $ = sel => document.querySelector(sel)
const views = { signin: $('[data-view="signin"]'), account: $('[data-view="account"]') }
const next = { setup: $('[data-next="setup"]'), ready: $('[data-next="ready"]') }
const wait = $('[data-wait]')

// ---- Signed out -----------------------------------------------------------------------------

const auth = mountAuth($('[data-auth]'), {
  // /account#create (and /signup) opens as "Join nexttupp."; the same button makes the account.
  mode: location.hash === '#create' ? 'create' : 'signin',
  onSignedIn: () => showAccount(),
  onMode: mode => {
    $('[data-signin-heading]').textContent = mode === 'create' ? 'Join nexttupp.' : 'Welcome back.'
    $('[data-signin-lede]').textContent = mode === 'create'
      ? 'Free, and anyone can make one. Continue with your Google account: there’s no password to remember.'
      : 'Sign in with your Google account. New here? The same button makes your free account.'
    history.replaceState(null, '', mode === 'create' ? '#create' : location.pathname)
  },
})

function showSignIn (message) {
  views.account.hidden = true
  views.signin.hidden = false
  if (message !== undefined) auth.setError(message) // keep what came back from Google
}

$('[data-signout]').addEventListener('click', async () => {
  await signOut()
  auth.setMode('signin')
  showSignIn()
})

// ---- Signed in ------------------------------------------------------------------------------

let account = null

function showAccount () {
  views.signin.hidden = true
  views.account.hidden = false
  history.replaceState(null, '', location.pathname)
  $('[data-heading]').textContent = 'You’re signed in.'
  $('[data-lede]').textContent = 'Just a moment…'
  next.setup.hidden = true
  next.ready.hidden = true
  wait.hidden = true
  account = null
  showWho(currentSession().email)
  void refresh()
}

function showWho (email, name) {
  $('[data-who]').textContent = name ? `Signed in as ${name} (${email})` : `Signed in as ${email}`
  for (const el of document.querySelectorAll('[data-email]')) el.textContent = email
}

async function refresh () {
  if (!currentSession()) return
  try {
    const [a, d] = await Promise.all([account ? null : api('GET', '/v1/account'), api('GET', '/v1/devices')])
    if (a) { account = a.account; showWho(account.email, account.displayName) }
    render(d.devices, d.serverTime)
  } catch (err) {
    if (signedOutError(err)) { forgetSession(); showSignIn('Sign in again to continue.'); return }
    $('[data-lede]').textContent = err.message
  }
}

// No polling: the page looks again when someone comes back to it (from the app, say, once it's signed in).
const again = () => { if (!document.hidden && currentSession() && !views.account.hidden) void refresh() }
document.addEventListener('visibilitychange', again)
window.addEventListener('focus', again)

function ago (ms, now) {
  const m = Math.round(Math.max(0, now - ms) / 60000)
  if (m < 60) return `${Math.max(m, 1)} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

const names = list => list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`

function render (devices, now = Date.now()) {
  const heading = $('[data-heading]')
  const lede = $('[data-lede]')
  if (!devices.length) {
    heading.textContent = 'Almost there.'
    lede.textContent = 'Your account is ready. Now get the app on your computer: that’s where films and series play.'
    next.setup.hidden = false
    next.ready.hidden = true
    wait.hidden = false
    return
  }
  next.setup.hidden = true
  next.ready.hidden = false
  wait.hidden = true
  heading.textContent = 'You’re all set.'
  lede.textContent = `nexttupp is set up on ${names(devices.map(d => d.name))}. Open it there to search and watch.`
  const list = $('[data-list]')
  list.replaceChildren()
  for (const d of devices) {
    const li = document.createElement('li')
    li.className = 'watch-row'
    const text = document.createElement('span')
    text.className = 'watch-row-text'
    const name = document.createElement('span')
    name.className = 'watch-row-name'
    name.textContent = d.name
    const meta = document.createElement('span')
    meta.className = 'watch-row-meta'
    // Computers only call the cloud on events, so this is when it last did: roughly when it was last used.
    meta.textContent = `Last seen ${ago(d.lastSeenAt, now)}`
    text.append(name, meta)
    li.append(text)
    list.append(li)
  }
}

if (currentSession()) showAccount(); else showSignIn()
