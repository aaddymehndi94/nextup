import { useState } from 'react'
import { Play, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import type { Rating, RecItem } from '../../../shared/types.ts'
import { useLoaded } from '../hooks.ts'
import { onLinkClick } from '../router.ts'
import { PosterCard } from './PosterCard.tsx'

/** The reason line often ends with the year ("Drama · Romance · 1995"); then the year isn't repeated above it. */
const withoutRepeatedYear = (item: RecItem) => (item.year && item.reason.text.includes(item.year) ? { ...item, year: undefined } : item)

/**
 * A recommended title: poster, name, year and the reason it is here. The small button beside the name
 * takes it off the screen ("Not interested", or "Remove from My List" in that row). It sits below the art
 * rather than over it, so a remote's Down key reaches it and Left/Right still move from poster to poster.
 */
export function RecCard ({ item, onRemove, removeLabel = 'Not interested' }: {
  item: RecItem
  onRemove?: (item: RecItem) => void
  removeLabel?: string
}) {
  return (
    <div className="card">
      <PosterCard title={withoutRepeatedYear(item)} note={item.reason.text} />
      {onRemove && (
        <div className="card-tools">
          <button type="button" className="card-remove" data-tip={removeLabel} aria-label={`${removeLabel}: ${item.name}`} onClick={() => onRemove(item)}>
            <X aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}

/** Where a Continue watching card leads: the title page, which picks the best source and starts playing. */
export const resumeHref = (item: RecItem) =>
  `/title/${item.type}/${item.id}?play=${encodeURIComponent(item.streamId ?? item.id)}`

/** Continue watching: landscape art with how far in you are, the episode, and one click to carry on. */
export function ContinueCard ({ item, onRemove }: { item: RecItem; onRemove: (item: RecItem) => void }) {
  const fraction = item.progress?.fraction ?? 0
  const label = `${item.progress ? 'Resume' : 'Play'} ${item.name}${item.reason.text ? `, ${item.reason.text}` : ''}`
  return (
    <article className="download continue-card">
      <a className="download-art" href={resumeHref(item)} onClick={onLinkClick} aria-label={label}>
        <LandscapeArt item={item} />
        <span className="download-play" aria-hidden><Play size={20} fill="currentColor" /></span>
        {fraction > 0 && <span className="download-progress" aria-hidden><span style={{ width: `${Math.max(3, fraction * 100)}%` }} /></span>}
      </a>
      <div className="download-text">
        <span className="download-title">{item.name}</span>
        <span className="download-status">{item.reason.text}</span>
      </div>
      <button type="button" className="icon-button download-delete" data-tip="Remove" aria-label={`Remove ${item.name} from Continue watching`} onClick={() => onRemove(item)}>
        <X aria-hidden />
      </button>
    </article>
  )
}

function LandscapeArt ({ item }: { item: RecItem }) {
  const src = item.background ?? `https://images.metahub.space/background/medium/${item.id}/img`
  const [failed, setFailed] = useState(false)
  const [loaded, onLoad] = useLoaded(src)
  if (failed) return <span className="download-fallback">{item.name}</span>
  return <img src={src} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />
}

/** Onboarding: a well-known title to like or dislike in one tap, without opening it. */
export function RateCard ({ item, rating, onRate }: { item: RecItem; rating: Rating; onRate: (item: RecItem, value: Rating) => void }) {
  const badge = rating === 0 ? null : (
    <span className="poster-badge" aria-hidden>{rating === 1 ? <ThumbsUp /> : <ThumbsDown />}</span>
  )
  return (
    <div className={`rate-card${rating ? ' is-rated' : ''}`}>
      <PosterCard title={withoutRepeatedYear(item)} note={item.reason.text} badge={badge} />
      <div className="rate-buttons" role="group" aria-label={`Rate ${item.name}`}>
        <button type="button" className="rate-button" aria-pressed={rating === 1} aria-label={`Like ${item.name}`} onClick={() => onRate(item, rating === 1 ? 0 : 1)}>
          <ThumbsUp aria-hidden />
        </button>
        <button type="button" className="rate-button" aria-pressed={rating === -1} aria-label={`Dislike ${item.name}`} onClick={() => onRate(item, rating === -1 ? 0 : -1)}>
          <ThumbsDown aria-hidden />
        </button>
      </div>
    </div>
  )
}
