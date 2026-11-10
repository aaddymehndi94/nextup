import { useState } from 'react'
import type { TitleSummary } from '../../../shared/types.ts'
import { onLinkClick } from '../router.ts'

export function PosterCard ({ title, showType = false }: { title: TitleSummary; showType?: boolean }) {
  const [failed, setFailed] = useState(!title.poster)
  return (
    <a className="poster" href={`/title/${title.type}/${title.id}`} onClick={onLinkClick}>
      <div className="poster-art">
        {failed
          ? <div className="poster-fallback"><span>{title.name}</span></div>
          : <img src={title.poster} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
        {showType && title.type === 'series' && <span className="poster-tag">Series</span>}
      </div>
      <div className="poster-meta">
        <span className="poster-name">{title.name}</span>
        {title.year && <span className="poster-year">{title.year}</span>}
      </div>
    </a>
  )
}
