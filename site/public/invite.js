// /invite: sign in on a phone, make an invite link (for one person, or a group link for a group chat),
// share it with the phone's share sheet, and see who joined. The link's code is shown once: the API keeps
// only its hash.

import { api, currentSession, forgetSession, signedOutError, signOut, wireSignIn } from './cloud.js'

/** Group links made here let this many people in (the API allows members up to 10). */
const GROUP_SIZE = 10
const DAY = 86_400_000

const $ = sel => document.querySelector(sel)
const views = { signin: $('[data-view="signin"]'), invites: $('[data-view="invites"]') }
const choices = $('[data-choices]')
const made = $('[data-made]')
const errorLine = $('[data-invite-error]')
const list = $('[data-list]')
const shareButton = $('[data-share]')
const copyButton = $('[data-copy]')
const madeStatus = $('[data-made-status]')
const canShare = typeof navigator.share === 'function'

$('[data-group-size]').textContent = String(GROUP_SIZE)

// ---- Signed in or out -------------------------------------------------------------------

const setSignInError = wireSignIn($('[data-signin]'), () => showInvites(), '/invite')

function showSignIn (message) {
  views.invites.hidden = true
  views.signin.hidden = false
  setSignInError(message)
}

function showInvites () {
  views.signin.hidden = true
  views.invites.hidden = false
  $('[data-who]').textContent = `Signed in as ${currentSession().email}`
  void load()
}

function handle (err) {
  if (signedOutError(err)) { forgetSession(); showSignIn('Sign in again to continue.'); return }
  errorLine.textContent = err.message
}

$('[data-signout]').addEventListener('click', async () => {
  await signOut()
  resetMade()
  showSignIn()
})

// ---- Making a link ----------------------------------------------------------------------

let link = null

for (const b of document.querySelectorAll('[data-make]')) {
  b.addEventListener('click', () => make(b.dataset.make === 'group', b))
}

async function make (group, button) {
  errorLine.textContent = ''
  const label = button.textContent
  for (const b of document.querySelectorAll('[data-make]')) b.disabled = true
  button.textContent = 'Making a link…'
  try {
    const r = await api('POST', '/v1/invites', group ? { maxUses: GROUP_SIZE } : {})
    link = r.url
    $('[data-made-label]').textContent = group ? `Group link · up to ${GROUP_SIZE} people` : 'Link for one person'
    $('[data-made-url]').textContent = r.url
    shareButton.hidden = !canShare
    copyButton.className = canShare ? 'button secondary large' : 'button primary large'
    madeStatus.textContent = 'This is the only time this link is shown, so send it now.'
    choices.hidden = true
    made.hidden = false
    void load()
  } catch (err) {
    handle(err)
  } finally {
    for (const b of document.querySelectorAll('[data-make]')) b.disabled = false
    button.textContent = label
  }
}

function resetMade () {
  link = null
  made.hidden = true
  choices.hidden = false
}

$('[data-again]').addEventListener('click', resetMade)

shareButton.addEventListener('click', async () => {
  if (!link) return
  try {
    await navigator.share({ title: 'Join me on nexttupp', text: 'Join me on nexttupp', url: link })
    madeStatus.textContent = 'Shared.'
  } catch (err) {
    if (err && err.name === 'AbortError') return // closed the share sheet
    madeStatus.textContent = 'Couldn’t open sharing. Copy the link instead.'
  }
})

copyButton.addEventListener('click', async () => {
  if (!link) return
  let ok = false
  try { await navigator.clipboard.writeText(link); ok = true } catch {
    const range = document.createRange()
    range.selectNodeContents($('[data-made-url]'))
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
    try { ok = document.execCommand('copy') } catch { ok = false }
  }
  madeStatus.textContent = ok ? 'Copied. Paste it into a chat.' : 'Couldn’t copy automatically. The link is selected: copy it from there.'
})

// ---- Your invites -----------------------------------------------------------------------

const isGroup = i => (i.maxUses || 1) > 1
const who = p => p.displayName || p.email
const day = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

function state (i, now) {
  const days = Math.ceil((i.expiresAt - now) / DAY)
  const left = days <= 1 ? 'expires within a day' : `expires in ${days} days`
  if (isGroup(i)) {
    const joined = `${i.uses || 0} of ${i.maxUses} joined`
    if (i.status === 'used') return `Full · ${joined}`
    if (i.status === 'revoked') return `Stopped · ${joined}`
    if (i.status === 'expired' || i.expiresAt <= now) return `Expired · ${joined}`
    return `${joined} · ${left}`
  }
  if (i.status === 'used') return i.usedBy ? `Joined: ${who(i.usedBy)}` : 'Joined'
  if (i.status === 'revoked') return 'Cancelled'
  if (i.status === 'expired' || i.expiresAt <= now) return 'Expired'
  return `Not used yet · ${left}`
}

async function load () {
  let invites
  try {
    invites = (await api('GET', '/v1/invites')).invites
  } catch (err) { handle(err); return }
  const now = Date.now()
  list.replaceChildren()
  for (const i of invites.slice(0, 12)) {
    const li = document.createElement('li')
    li.className = 'watch-row'
    const text = document.createElement('span')
    text.className = 'watch-row-text'
    const name = document.createElement('span')
    name.className = 'watch-row-name'
    name.textContent = `${isGroup(i) ? 'Group link' : 'Invite'} · ${day(i.createdAt)}`
    const meta = document.createElement('span')
    meta.className = 'watch-row-meta'
    meta.textContent = state(i, now)
    text.append(name, meta)
    if (isGroup(i) && i.joined && i.joined.length) {
      const people = document.createElement('span')
      people.className = 'watch-row-meta'
      people.textContent = i.joined.map(who).join(', ')
      text.append(people)
    }
    li.append(text)
    if (i.status === 'pending' && i.expiresAt > now) {
      const stop = document.createElement('button')
      stop.type = 'button'
      stop.className = 'button secondary small'
      stop.textContent = isGroup(i) ? 'Stop' : 'Cancel'
      stop.addEventListener('click', async () => {
        stop.disabled = true
        errorLine.textContent = ''
        try {
          await api('DELETE', `/v1/invites/${encodeURIComponent(i.id)}`)
          await load()
        } catch (err) { stop.disabled = false; handle(err) }
      })
      li.append(stop)
    }
    list.append(li)
  }
  $('[data-list-title]').hidden = invites.length === 0
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && currentSession() && !views.invites.hidden) void load() })

if (currentSession()) showInvites(); else showSignIn()
