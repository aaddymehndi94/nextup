import { useScrolled } from '../hooks.ts'
import { BrowseTabs } from './BrowseTabs.tsx'
import { ProfileMenu } from './ProfileMenu.tsx'
import { Wordmark } from './Wordmark.tsx'

/** The masthead of a section without a search of its own (My List, Downloads), and the space it covers. */
export function TabMasthead ({ current }: { current: string }) {
  const scrolled = useScrolled()
  return (
    <>
      <header className={`masthead${scrolled ? ' is-solid' : ''}`}>
        <div className="masthead-start">
          <Wordmark />
          <BrowseTabs current={current} />
        </div>
        <div className="masthead-end">
          <ProfileMenu />
        </div>
      </header>
      <div className="masthead-spacer" />
    </>
  )
}
