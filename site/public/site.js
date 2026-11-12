// nexttupp.com: picks the right download for this computer, says "Account" instead of "Sign in" once signed in,
// plus two small touches (masthead veil, reveal).
// No requests leave the page; everything below works on the document and the saved session alone.

import { currentSession } from './cloud.js'

const RELEASES = 'https://github.com/aaddymehndi94/nextup/releases/latest/download/'

export const FILES = {
  macArm: { href: RELEASES + 'nexttupp-mac-arm64.dmg', label: 'Apple Silicon' },
  macIntel: { href: RELEASES + 'nexttupp-mac-x64.dmg', label: 'Intel Mac' },
  windows: { href: RELEASES + 'nexttupp-windows-x64.exe', label: 'Windows' },
  appImage: { href: RELEASES + 'nexttupp-linux-x86_64.AppImage', label: 'AppImage' },
  deb: { href: RELEASES + 'nexttupp-linux-amd64.deb', label: '.deb' },
}

/** 'mac' | 'windows' | 'linux' | 'mobile' | 'other'. A Mac's chip can't be told reliably, so Mac means Apple Silicon. */
export function detectOS () {
  const ua = navigator.userAgent || ''
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return 'mobile'
  if (/Mac/i.test(platform) && navigator.maxTouchPoints > 1) return 'mobile' // iPadOS reports a Mac
  if (/Mac/i.test(platform) || /Macintosh/.test(ua)) return 'mac'
  if (/Win/i.test(platform) || /Windows/.test(ua)) return 'windows'
  if (/CrOS/.test(ua)) return 'other'
  if (/Linux|X11/i.test(platform) || /Linux|X11/.test(ua)) return 'linux'
  return 'other'
}

const PLAN = {
  mac: { label: 'Download for Mac', file: FILES.macArm, note: ['Apple Silicon', FILES.macIntel] },
  windows: { label: 'Download for Windows', file: FILES.windows, note: ['64-bit'] },
  linux: { label: 'Download for Linux', file: FILES.appImage, note: ['AppImage', { href: FILES.deb.href, label: '.deb for Ubuntu and Debian' }] },
}

function link (href, text) {
  const a = document.createElement('a')
  a.href = href
  a.textContent = text
  return a
}
function sep () {
  const s = document.createElement('span')
  s.className = 'sep'
  s.setAttribute('aria-hidden', 'true')
  s.textContent = '·'
  return s
}

/** Fills every [data-get] block: the button points at this computer's file, the note at the others. */
function setUpDownloads (os) {
  const plan = PLAN[os]
  for (const block of document.querySelectorAll('[data-get]')) {
    const button = block.querySelector('[data-get-button]')
    const label = block.querySelector('[data-get-label]')
    const note = block.querySelector('[data-get-note]')
    const all = block.dataset.get || '#download'
    if (!button || !label || !note) continue
    if (!plan) {
      // Phones, tablets, Chromebooks: nexttupp is a desktop app for now, and a phone plays from the computer.
      label.textContent = 'Download for your computer'
      button.href = all
      if (os === 'mobile') note.replaceChildren('For Windows, Mac and Linux.', sep(), link('/watch', 'Already have it? Watch on this phone'))
      else note.replaceChildren('For Windows, Mac and Linux.')
      continue
    }
    label.textContent = plan.label
    button.href = plan.file.href
    const parts = []
    for (const item of plan.note) parts.push(typeof item === 'string' ? item : link(item.href, item.label))
    parts.push(link(all, 'Other platforms'))
    note.replaceChildren()
    parts.forEach((p, i) => { if (i) note.append(sep()); note.append(p) })
  }
  // The full list marks this computer's file.
  const mine = { mac: 'macArm', windows: 'windows', linux: 'appImage' }[os]
  if (mine) document.querySelector(`[data-file="${mine}"]`)?.classList.add('is-yours')
}

function setUpMasthead () {
  const bar = document.querySelector('.masthead')
  if (!bar) return
  const update = () => bar.classList.toggle('is-scrolled', window.scrollY > 8)
  update()
  window.addEventListener('scroll', update, { passive: true })
}

/** Sections below the fold fade up once as they arrive. Without JS (or with reduced motion) they simply show. */
function setUpReveal () {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target) }
  }, { rootMargin: '0px 0px -10% 0px' })
  for (const el of document.querySelectorAll('.reveal')) {
    if (el.getBoundingClientRect().top < window.innerHeight) continue
    el.classList.add('is-pending')
    io.observe(el)
  }
}

/** Signed in on this site (cloud.js keeps the session): the masthead's "Sign in" becomes "Account". */
function setUpAccountLinks () {
  if (!currentSession()) return
  for (const a of document.querySelectorAll('[data-account-link]')) a.textContent = 'Account'
  for (const a of document.querySelectorAll('[data-create-link]')) { a.textContent = 'Your account'; a.href = '/account' }
}

setUpDownloads(detectOS())
setUpAccountLinks()
setUpMasthead()
setUpReveal()
