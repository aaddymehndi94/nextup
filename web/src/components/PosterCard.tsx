import { useState } from 'react'
import type { TitleSummary } from '../../../shared/types.ts'
import { useLoaded } from '../hooks.ts'
import { onLinkClick } from '../router.ts'

export function PosterCard ({ title, showType = false, note }: { title: TitleSummary; showType?: boolean; note?: string }) {
  const [failed, setFailed] = useState(!title.poster)
  const [loaded, onLoad] = useLoaded(title.poster)
  return (
    <a className="poster" href={`/title/${title.type}/${title.id}`} onClick={onLinkClick}>
      <div className="poster-art">
        {failed
          ? <div className="poster-fallback"><span>{title.name}</span></div>
          : <img src={title.poster} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />}
        {showType && title.type === 'series' && <span className="poster-tag">Series</span>}
      </div>
      <div className="poster-meta">
        <span className="poster-name">{title.name}</span>
        {title.year && <span className="poster-year">{title.year}</span>}
        {note && <span className="poster-note">{note}</span>}
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
