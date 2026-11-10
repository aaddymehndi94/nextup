import { useSyncExternalStore } from 'react'

// A tiny history router: three routes don't justify a dependency.

const listeners = new Set<() => void>()
const notify = () => listeners.forEach(l => l())
window.addEventListener('popstate', notify)

export function navigate (to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return
  if (opts.replace) history.replaceState(null, '', to); else history.pushState(null, '', to)
  window.scrollTo(0, 0)
  notify()
}

export function useLocation () {
  const href = useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => location.pathname + location.search)
  const url = new URL(href, location.origin)
  return { path: url.pathname, query: url.searchParams }
}

/** Intercepts plain left-clicks on internal links so they route without a reload. */
export function onLinkClick (e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const href = e.currentTarget.getAttribute('href')
  if (!href || !href.startsWith('/')) return
  e.preventDefault()
  navigate(href)
}
