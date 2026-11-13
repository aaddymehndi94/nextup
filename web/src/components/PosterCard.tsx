import { useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { TitleSummary } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useLoaded } from '../hooks.ts'
import { onLinkClick } from '../router.ts'
import { warmYouTube } from '../youtube.ts'

/**
 * A poster linking to its title. With `onOpen`, a plain click calls it instead (the quick view), and resting
 * the pointer on it a moment fetches the details and warms up YouTube, so the popup opens straight into the
 * trailer. Ctrl-click or middle-click still open the title page.
 */
export function PosterCard ({ title, showType = false, note, badge, onOpen }: { title: TitleSummary; showType?: boolean; note?: string; badge?: ReactNode; onOpen?: () => void }) {
  const [failed, setFailed] = useState(!title.poster)
  const [loaded, onLoad] = useLoaded(title.poster)
  const hover = useRef<number | undefined>(undefined)
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { onLinkClick(e); return }
    e.preventDefault()
    onOpen()
  }
  return (
    <a
      className="poster"
      href={`/title/${title.type}/${title.id}`}
      onClick={onClick}
      onPointerEnter={e => {
        if (!onOpen || e.pointerType !== 'mouse') return
        clearTimeout(hover.current)
        hover.current = window.setTimeout(() => { warmYouTube(); api.title(title.type, title.id).catch(() => {}) }, 350)
      }}
      onPointerLeave={() => clearTimeout(hover.current)}
    >
      <div className="poster-art">
        {failed
          ? <div className="poster-fallback"><span>{title.name}</span></div>
          : <img src={title.poster} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />}
        {showType && title.type === 'series' && <span className="poster-tag">Series</span>}
        {badge}
      </div>
      <div className="poster-meta">
        <span className="poster-name">{title.name}</span>
        {title.year && <span className="poster-year">{title.year}</span>}
        {note && <span className="poster-note" title={note}>{note}</span>}
      </div>
    </a>
  )
}

export function PosterSkeleton () {
  return (
    <div className="poster-skeleton" aria-hidden>
      <div className="poster-art skeleton" />
      <div className="poster-meta"><span className="skeleton-line" /><span className="skeleton-line short" /></div>
    </div>
  )
}
