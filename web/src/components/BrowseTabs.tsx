import type { MediaType } from '../../../shared/types.ts'
import { onLinkClick } from '../router.ts'

/** The masthead's sections: Home, Films, Series and Music. */
export const TABS: Array<{ href: string; label: string; tab?: MediaType }> = [
  { href: '/', label: 'Home' },
  { href: '/films', label: 'Films', tab: 'movie' },
  { href: '/series', label: 'Series', tab: 'series' },
  { href: '/music', label: 'Music' },
]

export function BrowseTabs ({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  return (
    <nav className="tabs" aria-label="Browse">
      {TABS.map(t => (
        <a key={t.href} href={t.href} onClick={e => { onNavigate?.(); onLinkClick(e) }} aria-current={t.href === current ? 'page' : undefined}>{t.label}</a>
      ))}
    </nav>
  )
}
