import { onLinkClick } from '../router.ts'

export function Wordmark () {
  return (
    <a href="/" onClick={onLinkClick} className="wordmark" aria-label="nextup home">
      next<em>up</em>
    </a>
  )
}
