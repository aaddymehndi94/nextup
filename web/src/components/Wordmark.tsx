import { onLinkClick } from '../router.ts'

/** The nexttupp logotype: Mona Sans Expanded ExtraBold, tracked so the two t's share one crossbar. */
export function Wordmark () {
  return (
    <a href="/" onClick={onLinkClick} className="wordmark" aria-label="nexttupp home">
      nexttupp
    </a>
  )
}
