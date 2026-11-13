import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

// A tiny history router: three routes don't justify a dependency.
//
// Every history entry has a key (in history.state). Pages are told apart by it, not by their address, so Back
// can show the same list page it left, scrolled where it was (main.tsx keeps list pages alive by key). The
// quick-view popup is an entry of its own over the page beneath (`base`), so Back closes it on phones too.

interface Entry { depth?: number; key?: string; base?: string; preview?: string }

const listeners = new Set<() => void>()
const notify = () => listeners.forEach(l => l())
const entry = (): Entry => (history.state ?? {}) as Entry

let seq = 0
const newKey = () => `${Date.now().toString(36)}${(seq++).toString(36)}`

/** The page this entry shows: the popup's entries show the page they were opened over. */
const pageKey = (): string => entry().base ?? entry().key ?? ''

if (!entry().key) history.replaceState({ ...entry(), key: newKey() }, '')
// The browser can't put the scroll back itself: the page beneath is drawn by script, after the fact.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

/** Where each page was scrolled to, by key; saved as the viewer scrolls. */
const scrolls = new Map<string, number>()
let frame = 0
window.addEventListener('scroll', () => {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => { scrolls.set(pageKey(), window.scrollY) })
}, { passive: true })

/** The scroll to put back once the page Back or Forward went to is on screen. */
let pending: number | null = null

/**
 * Shows the new page. Going to another page cross-fades (a View Transition, where the browser has them); a new
 * query on the same page (search, a filter), the popup, or the Now Playing sheet just updates.
 */
let shownPath = location.pathname
let shownKey = pageKey()
function show (update: () => void) {
  const changed = location.pathname !== shownPath
  shownPath = location.pathname
  shownKey = pageKey()
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  if (!changed || !doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { update(); return }
  doc.startViewTransition(() => flushSync(update))
}
window.addEventListener('popstate', () => {
  pending = pageKey() !== shownKey ? scrolls.get(pageKey()) ?? 0 : null
  show(notify)
})

/**
 * How many of the app's own pages lie behind this one. It's kept in history.state, so it survives a reload and
 * Back/Forward; a page opened from a bookmark or a fresh window has none. (document.referrer can't tell: in a
 * single-page app it's fixed when the app first loads, and the desktop app never has one.)
 */
const depth = (): number => {
  const d = entry().depth
  return typeof d === 'number' && d > 0 ? d : 0
}

export function navigate (to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search && !entry().preview) return
  scrolls.set(pageKey(), window.scrollY)
  pending = null
  if (opts.replace) history.replaceState({ depth: depth(), key: newKey() }, '', to)
  else history.pushState({ depth: depth() + 1, key: newKey() }, '', to)
  show(() => { window.scrollTo(0, 0); notify() })
}

/** Updates the address for the same page (a search, a filter, a season) without a new history entry. */
export function replaceUrl (to: string) {
  history.replaceState(history.state, '', to)
}

/** Back to the page the viewer came from in the app, or to `fallback` when this page was opened directly. */
export function goBack (fallback: string) {
  if (depth() > 0) history.back(); else navigate(fallback, { replace: true })
}

/** Opens the quick-view popup for "movie/tt…" or "series/tt…" over this page, as a history entry. */
export function openPreview (ref: string) {
  const e = entry()
  scrolls.set(pageKey(), window.scrollY)
  const next = { depth: e.preview ? depth() : depth() + 1, key: newKey(), base: pageKey(), preview: ref }
  // One popup at a time: from a popup, the next title replaces it, so Back still goes to the page.
  if (e.preview) history.replaceState(next, ''); else history.pushState(next, '')
  show(notify)
}

/** Closes the popup (its history entry). */
export function closePreview () {
  if (entry().preview) history.back()
}

/**
 * After Back or Forward: puts the page's scroll back. A page kept alive is already full height; one drawn again
 * grows as its data arrives, so this keeps trying for a moment, until it fits or the viewer scrolls.
 */
export function restoreScroll () {
  const y = pending
  pending = null
  if (y === null) return
  window.scrollTo(0, y)
  if (Math.abs(window.scrollY - y) < 2) return
  const stop = () => {
    clearTimeout(timer)
    ro.disconnect()
    for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.removeEventListener(ev, stop)
  }
  const ro = new ResizeObserver(() => {
    window.scrollTo(0, y)
    if (Math.abs(window.scrollY - y) < 2) stop()
  })
  ro.observe(document.body)
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.addEventListener(ev, stop, { passive: true })
  const timer = setTimeout(stop, 3000)
}

const snapshot = () => `${pageKey()} ${entry().preview ?? ''} ${location.pathname}${location.search}`

/** The address on screen, the page's key, and the popup's title if it's open. */
export function useLocation () {
  const snap = useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, snapshot)
  const [key, preview, href] = snap.split(' ')
  const url = new URL(href, location.origin)
  return { path: url.pathname, query: url.searchParams, key, preview: preview || null }
}

/** Intercepts plain left-clicks on internal links so they route without a reload. */
export function onLinkClick (e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const href = e.currentTarget.getAttribute('href')
  if (!href || !href.startsWith('/')) return
  e.preventDefault()
  navigate(href)
}
