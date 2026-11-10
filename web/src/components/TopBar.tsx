import { ArrowLeft } from 'lucide-react'
import { onLinkClick } from '../router.ts'
import { ProfileMenu } from './ProfileMenu.tsx'
import { Wordmark } from './Wordmark.tsx'

/** Back, the wordmark and the profile menu, over a hero or at the top of a plain page. */
export function TopBar ({ solid = false, profile = true }: { solid?: boolean; profile?: boolean }) {
  return (
    <nav className={`topbar${solid ? ' is-solid' : ''}`} aria-label="Page">
      <a href="/" onClick={e => { if (history.length > 1 && document.referrer.startsWith(location.origin)) { e.preventDefault(); history.back() } else onLinkClick(e) }} className="round-button" aria-label="Back">
        <ArrowLeft aria-hidden />
      </a>
      <Wordmark />
      {profile && <div className="topbar-end"><ProfileMenu /></div>}
    </nav>
  )
}
