// /watch: sign in on a phone, find the computer running nexttupp on the same Wi-Fi, and open it.
//
// The phone talks only to the nexttupp API. An HTTPS page can't fetch the computer's http:// address (mixed
// content), so "Watch" asks the API for a one-time code and then navigates the whole tab to
// http://<computer>/handoff?code=…; the computer checks the code with the API and lets this phone in with a
// cookie. Signing in, and the session, are in cloud.js.

import { api, ApiError, currentSession, forgetSession, signedOutError, signOut, wireSignIn } from './cloud.js'

const LAN_URL = /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{1,5}$/
const POLL_MS = 5000

const $ = sel => document.querySelector(sel)
const views = { signin: $('[data-view="signin"]'), devices: $('[data-view="devices"]') }

// ---- Sign in ----------------------------------------------------------------------------

const setSignInError = wireSignIn($('[data-signin]'), () => showDevices(), '/watch')

function showSignIn (message) {
  clearTimeout(pollTimer)
  views.devices.hidden = true
  views.signin.hidden = false
  setSignInError(message)
}

$('[data-signout]').addEventListener('click', async () => {
  await signOut()
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
    status.textContent = err.message
  }
  if (!document.hidden) pollTimer = setTimeout(refresh, POLL_MS)
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && currentSession() && !views.devices.hidden) void refresh() })

const canWatch = d => d.online && d.lan && d.lanUrls.some(u => LAN_URL.test(u))

function button (label, kind, onClick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `button ${kind}`
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>'
  const span = document.createElement('span')
  span.textContent = label
  b.append(span)
  b.addEventListener('click', () => onClick(b))
  return b
}

function render (devices) {
  const online = devices.filter(d => d.online)
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
    lede.textContent = 'It’s on this Wi-Fi. The film plays from it, right here on this phone.'
    primary.append(button(`Watch on ${here[0].name}`, 'primary large', b => watchOn(here[0], b)))
  } else if (here.length > 1) {
    heading.textContent = 'Watch at home.'
    lede.textContent = 'These computers are on this Wi-Fi. Pick the one to watch from.'
  } else if (elsewhere.length) {
    heading.textContent = 'Watch at home.'
    lede.textContent = 'We couldn’t confirm a computer on this Wi-Fi. If this phone is on the same Wi-Fi as one of these, tap it.'
  } else {
    heading.textContent = 'Open nexttupp on your computer.'
    lede.textContent = off.length
      ? `Watching on phones is turned off on ${off.map(d => d.name).join(' and ')}. Turn on “Watch on phones and TVs at home” in nexttupp, under Account.`
      : `No computer signed in as ${currentSession().email} is running nexttupp right now. Open it, signed in to the same account, and it shows up here.`
  }

  const rows = here.length === 1 ? elsewhere : [...here, ...elsewhere]
  for (const d of rows) {
    const li = document.createElement('li')
    li.className = 'watch-row'
    const text = document.createElement('span')
    text.className = 'watch-row-text'
    const name = document.createElement('span')
    name.className = 'watch-row-name'
    name.textContent = d.name
    const meta = document.createElement('span')
    meta.className = 'watch-row-meta'
    meta.textContent = d.sameNetwork ? 'On this Wi-Fi' : 'Not confirmed on this Wi-Fi'
    text.append(name, meta)
    li.append(text, button('Watch', 'secondary small', b => watchOn(d, b)))
    list.append(li)
  }
  list.hidden = rows.length === 0
  if (here.length || elsewhere.length || off.length || devices.length) return
  status.textContent = 'Looking every few seconds…'
}

async function watchOn (device, b) {
  if (handingOff) return
  handingOff = true
  clearTimeout(pollTimer)
  b.disabled = true
  status.textContent = `Opening ${device.name}…`
  try {
    const r = await api('POST', `/v1/devices/${encodeURIComponent(device.id)}/handoff`)
    const base = [...(r.lanUrls || []), ...device.lanUrls].find(u => LAN_URL.test(u))
    if (!base || !/^nxh_[A-Za-z0-9_-]{43}$/.test(r.code)) throw new ApiError(0, 'bad_device', 'That computer didn’t give an address on your Wi-Fi.')
    status.textContent = `Opening ${device.name}… If nothing happens, check that this phone is on the same Wi-Fi as the computer.`
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
window.addEventListener('pageshow', e => { if (e.persisted) { handingOff = false; if (currentSession()) void refresh() } })

if (currentSession()) showDevices(); else showSignIn()
