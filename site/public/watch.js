// /watch: sign in (or create an account) on a phone, find the computer running nexttupp on the same Wi-Fi, and open it.
//
// The phone talks only to the nexttupp API. An HTTPS page can't fetch the computer's http:// address (mixed
// content), so "Connect" asks the API for a one-time code and then navigates the whole tab to
// http://<computer>/handoff?code=…; the computer checks the code with the API and lets this phone in with a
// cookie. Signing in, and the session, are in cloud.js.
//
// Added to a phone's home screen (watch.webmanifest, scope /watch), this page is the phone app. Opened that way it
// connects by itself when exactly one of the account's computers is on this Wi-Fi; with more, it asks which. The
// computer last opened is remembered on the phone, so it can be opened again while signed out or offline (the
// phone's cookie on the computer is what lets it in). watch-sw.js keeps this page for when there's no internet.

import { api, ApiError, currentSession, forgetSession, mountAuth, signedOutError, signOut } from './cloud.js'
import { detectOS } from './site.js'

const LAN_URL = /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{1,5}$/
const POLL_MS = 5000
const LAST_KEY = 'nexttupp:last-computer'
const AUTO_KEY = 'nexttupp:auto-connected'

const $ = sel => document.querySelector(sel)
const views = { signin: $('[data-view="signin"]'), devices: $('[data-view="devices"]') }

const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const navigation = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null
// Once per visit, only in the installed app, and not when someone came back to choose ("Switch computer" in the
// app on the computer links to /watch?choose, or Back).
let autoConnect = installed && !new URLSearchParams(location.search).has('choose') &&
  navigation?.type !== 'back_forward' && !store('session', AUTO_KEY)

/** Web storage ('local' or 'session') that may be missing or blocked: reads give null, writes are best effort. */
function store (where, key, value) {
  try {
    const area = where === 'session' ? sessionStorage : localStorage
    if (value === undefined) return area.getItem(key)
    if (value === null) area.removeItem(key); else area.setItem(key, value)
  } catch { /* private mode or blocked storage */ }
  return null
}

/** The computer this phone last opened: { id, name, urls }, or null. */
function lastComputer () {
  try {
    const v = JSON.parse(store('local', LAST_KEY))
    return v && typeof v.name === 'string' && Array.isArray(v.urls) && v.urls.some(u => LAN_URL.test(u)) ? v : null
  } catch { return null }
}

// ---- Sign in ----------------------------------------------------------------------------

const SIGNIN_LEDE = $('[data-signin-lede]').textContent
const auth = mountAuth($('[data-auth]'), {
  path: '/watch',
  onSignedIn: () => showDevices(),
  onMode: mode => {
    $('[data-signin-lede]').textContent = mode === 'create'
      ? 'Create your free account. Then get nexttupp on your computer and sign in there too, and films play here, streamed from it.'
      : SIGNIN_LEDE
  },
})

function showSignIn (message) {
  clearTimeout(pollTimer)
  views.devices.hidden = true
  views.signin.hidden = false
  auth.setError(message)
  // Signed out by the service (expired, or removed elsewhere), this phone can still open the computer it used last.
  const last = lastComputer()
  const box = $('[data-last]')
  box.hidden = !last
  box.querySelector('button')?.remove()
  if (!last) return
  $('[data-last-text]').textContent = `Used ${last.name} on this phone before? Open it without signing in, while this phone is on the same Wi‑Fi.`
  box.append(button(`Open ${last.name}`, 'secondary', () => openLast(last)))
}

$('[data-signout]').addEventListener('click', async () => {
  await signOut()
  // Signing out on purpose forgets the shortcut too.
  store('local', LAST_KEY, null)
  auth.setMode('signin')
  showSignIn()
})

// ---- Devices ----------------------------------------------------------------------------

let pollTimer
let handingOff = false
const status = $('[data-status]')

function showDevices () {
  views.signin.hidden = true
  views.devices.hidden = false
  $('[data-who]').textContent = `Signed in as ${currentSession().email}`
  void refresh()
}

async function refresh () {
  clearTimeout(pollTimer)
  if (!currentSession() || handingOff) return
  try {
    const r = await api('GET', '/v1/devices')
    render(r.devices)
  } catch (err) {
    if (signedOutError(err)) { forgetSession(); showSignIn('Sign in again to continue.'); return }
    if (err.status === 0 || err.status >= 500) unreachable(err.status === 0)
    else status.textContent = err.message
  }
  if (!document.hidden) pollTimer = setTimeout(refresh, POLL_MS)
}

/** No internet, or the service is down. The computer on this Wi-Fi doesn't need either to let this phone in. */
function unreachable (offline) {
  if (handingOff) return
  const last = lastComputer()
  const still = last ? `You can still open ${last.name} while this phone is on the same Wi‑Fi.` : 'This page tries again by itself.'
  $('[data-heading]').textContent = offline ? 'This phone seems to be offline.' : 'nexttupp.com isn’t answering right now.'
  $('[data-lede]').textContent = offline ? `Check its internet connection. ${still}` : still
  $('[data-primary]').replaceChildren(...(last ? [button(`Open ${last.name}`, 'primary large', () => openLast(last))] : []))
  $('[data-list]').replaceChildren()
  $('[data-list]').hidden = true
  status.textContent = 'Trying again every few seconds…'
}

/** Straight to the computer's address. Its cookie lets this phone in; nexttupp's service isn't asked. */
function openLast (last) {
  const msg = `Opening ${last.name}… If nothing opens, this phone isn’t on the same Wi‑Fi, or ${last.name} has a new address: sign in and connect again.`
  if (views.signin.hidden) status.textContent = msg; else $('[data-last-text]').textContent = msg
  location.assign(`${last.urls.find(u => LAN_URL.test(u))}/`)
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && currentSession() && !views.devices.hidden) void refresh() })

const canWatch = d => d.online && d.lan && d.lanUrls.some(u => LAN_URL.test(u))

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>'
const ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'

function button (label, kind, onClick, icon = PLAY) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `button ${kind}`
  b.innerHTML = icon
  const span = document.createElement('span')
  span.textContent = label
  b.append(span)
  b.addEventListener('click', () => onClick(b))
  return b
}

function render (devices) {
  const lastId = lastComputer()?.id
  // The one used last comes first.
  const online = devices.filter(d => d.online).sort((a, b) => (b.id === lastId) - (a.id === lastId))
  const here = online.filter(d => d.sameNetwork && canWatch(d))
  const elsewhere = online.filter(d => !here.includes(d) && canWatch(d))
  const off = online.filter(d => !d.lan)
  const heading = $('[data-heading]')
  const lede = $('[data-lede]')
  const primary = $('[data-primary]')
  const list = $('[data-list]')
  primary.replaceChildren()
  list.replaceChildren()
  if (!handingOff) status.textContent = ''

  if (here.length === 1) {
    heading.textContent = `${here[0].name} is ready.`
    lede.textContent = 'It’s on this Wi-Fi. Connect, and anything you pick plays here on this phone, streamed from it.'
    const b = button(`Connect to ${here[0].name}`, 'primary large', b => watchOn(here[0], b))
    primary.append(b)
    if (autoConnect) {
      autoConnect = false
      store('session', AUTO_KEY, '1')
      void watchOn(here[0], b)
    }
  } else if (here.length > 1) {
    autoConnect = false // they're choosing; one going offline mustn't pick for them
    heading.textContent = 'Pick your computer.'
    lede.textContent = 'These computers are on this Wi-Fi. Connect to one, and films play here, streamed from it.'
  } else if (elsewhere.length) {
    heading.textContent = 'Pick your computer.'
    lede.textContent = 'We couldn’t confirm one on this Wi-Fi. If this phone is on the same Wi-Fi as one of these, tap Connect.'
  } else if (off.length) {
    heading.textContent = 'Turn on phones on your computer.'
    lede.textContent = `Phones are turned off on ${off.map(d => d.name).join(' and ')}. In nexttupp there, click your profile picture, choose Account, and turn on “Let phones play from this computer”.`
  } else if (devices.length) {
    heading.textContent = 'Open nexttupp on your computer.'
    lede.textContent = `nexttupp isn’t open on ${devices.map(d => d.name).join(' or ')} right now. Open it there, and it shows up here in a few seconds.`
  } else {
    heading.textContent = 'Set up your computer first.'
    lede.textContent = `Films play from the nexttupp app on a computer. On your laptop or desktop, go to nexttupp.com, download nexttupp, open it and sign in as ${currentSession().email}. This page updates by itself once it’s ready.`
  }

  const rows = here.length === 1 ? elsewhere : [...here, ...elsewhere]
  for (const [i, d] of rows.entries()) {
    const li = document.createElement('li')
    li.className = 'watch-row'
    const text = document.createElement('span')
    text.className = 'watch-row-text'
    const name = document.createElement('span')
    name.className = 'watch-row-name'
    name.textContent = d.name
    const meta = document.createElement('span')
    meta.className = 'watch-row-meta'
    meta.textContent = [d.id === lastId ? 'Last used' : '', d.sameNetwork ? 'On this Wi‑Fi' : 'Not confirmed on this Wi‑Fi'].filter(Boolean).join(' · ')
    text.append(name, meta)
    // With no big button above, the first (last used, on this Wi-Fi) is the one white action.
    li.append(text, button('Connect', i === 0 && here.length !== 1 ? 'primary small' : 'secondary small', b => watchOn(d, b)))
    list.append(li)
  }
  list.hidden = rows.length === 0
  if (here.length || elsewhere.length || off.length) return
  status.textContent = 'Checking every few seconds…'
}

async function watchOn (device, b) {
  if (handingOff) return
  handingOff = true
  clearTimeout(pollTimer)
  b.disabled = true
  status.textContent = `Connecting to ${device.name}…`
  try {
    const r = await api('POST', `/v1/devices/${encodeURIComponent(device.id)}/handoff`)
    const base = [...(r.lanUrls || []), ...device.lanUrls].find(u => LAN_URL.test(u))
    if (!base || !/^nxh_[A-Za-z0-9_-]{43}$/.test(r.code)) throw new ApiError(0, 'bad_device', 'That computer didn’t give an address on your Wi-Fi.')
    status.textContent = `Connecting to ${device.name}… If nothing happens, check that this phone is on the same Wi-Fi as the computer.`
    const urls = [...(r.lanUrls || []), ...device.lanUrls].filter(u => LAN_URL.test(u))
    store('local', LAST_KEY, JSON.stringify({ id: device.id, name: device.name, urls: [...new Set(urls)] }))
    // A top-level navigation: the only way from an https page to the computer's http address.
    location.assign(`${base}/handoff?code=${encodeURIComponent(r.code)}`)
    // Coming back (Back button, or the page stays because the address didn't answer) re-enables everything.
    setTimeout(() => { handingOff = false; b.disabled = false; void refresh() }, 15000)
  } catch (err) {
    handingOff = false
    b.disabled = false
    if (err.status === 401) { forgetSession(); showSignIn('Sign in again to continue.'); return }
    status.textContent = err.message
    pollTimer = setTimeout(refresh, POLL_MS)
  }
}

// Back from the computer's page via the browser's Back button: the page may come from the back/forward cache.
window.addEventListener('pageshow', e => { if (e.persisted) { autoConnect = false; handingOff = false; if (currentSession()) void refresh() } })

// ---- Add to home screen -----------------------------------------------------------------

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1)
let installPrompt = null

function showInstall () {
  const box = $('[data-install]')
  box.querySelector('button')?.remove()
  box.hidden = installed || detectOS() !== 'mobile' || (!installPrompt && !ios)
  if (box.hidden) return
  const why = 'It opens like an app and finds your computer by itself.'
  $('[data-install-text]').textContent = installPrompt
    ? `Add nexttupp to your home screen. ${why}`
    : `Add nexttupp to your home screen: tap Share, then “Add to Home Screen”. ${why}`
  if (installPrompt) {
    box.append(button('Add to home screen', 'secondary small', async () => {
      const prompt = installPrompt
      installPrompt = null
      await prompt.prompt().catch(() => {})
      showInstall()
    }, ADD))
  }
}

// Chrome on Android offers the install when the page qualifies; we show it as a quiet button instead of its banner.
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; showInstall() })
window.addEventListener('appinstalled', () => { installPrompt = null; showInstall() })

// The phone app's offline copy of this page. Scope /watch: the rest of nexttupp.com stays an ordinary website.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/watch-sw.js', { scope: '/watch' }).catch(() => {})

showInstall()
if (currentSession()) showDevices(); else showSignIn()
