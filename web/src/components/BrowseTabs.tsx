import { useLayoutEffect, useRef } from 'react'
import type { MediaType } from '../../../shared/types.ts'
import { onLinkClick } from '../router.ts'

/** The masthead's sections: Home, Films, Series, Music, My List and Downloads. */
export const TABS: Array<{ href: string; label: string; tab?: MediaType }> = [
  { href: '/', label: 'Home' },
  { href: '/films', label: 'Films', tab: 'movie' },
  { href: '/series', label: 'Series', tab: 'series' },
  { href: '/music', label: 'Music' },
  { href: '/list', label: 'My List' },
  { href: '/downloads', label: 'Downloads' },
]

export function BrowseTabs ({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  // On a narrow phone the row scrolls: keep the current tab in view.
  const nav = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const row = nav.current
    const tab = row?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return
    row.scrollLeft = Math.max(0, tab.offsetLeft + tab.offsetWidth - row.clientWidth + 16)
  }, [current])
  return (
    <nav className="tabs" aria-label="Browse" ref={nav}>
      {TABS.map(t => (
        <a key={t.href} href={t.href} onClick={e => { onNavigate?.(); onLinkClick(e) }} aria-current={t.href === current ? 'page' : undefined}>{t.label}</a>
      ))}
    </nav>
  )
}
