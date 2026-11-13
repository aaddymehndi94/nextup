import { ArrowLeft } from 'lucide-react'
import { goBack } from '../router.ts'
import { ProfileMenu } from './ProfileMenu.tsx'
import { Wordmark } from './Wordmark.tsx'

/**
 * Back, the wordmark and the profile menu, over a hero or at the top of a plain page. Back returns to the page
 * the viewer came from; `up` is where it goes when they opened this page directly (Music for music pages).
 */
export function TopBar ({ solid = false, profile = true, up = '/' }: { solid?: boolean; profile?: boolean; up?: string }) {
  return (
    <nav className={`topbar${solid ? ' is-solid' : ''}`} aria-label="Page">
      <a href={up} onClick={e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); goBack(up) }} className="round-button" aria-label="Back">
        <ArrowLeft aria-hidden />
      </a>
      <Wordmark />
      {profile && <div className="topbar-end"><ProfileMenu /></div>}
    </nav>
  )
}
