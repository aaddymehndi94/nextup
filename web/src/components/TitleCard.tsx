import type { MouseEvent, ReactNode } from 'react'
import { Check, Plus, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import type { TitleSummary } from '../../../shared/types.ts'
import { rateTitle, setTitleInList, useMark } from '../marks.ts'
import { PosterCard } from './PosterCard.tsx'
import { showPreview } from './Preview.tsx'

/** Where a rating was given: the home row it was in (its data-source), else 'card'. */
const sourceOf = (e: MouseEvent<HTMLElement>) => e.currentTarget.closest('[data-source]')?.getAttribute('data-source') ?? 'card'

/**
 * A poster with My List, Like and Dislike always under it, showing what this profile chose; a click opens the
 * quick view (Preview.tsx) with its trailer. `onRemove` adds a fourth button at the end that takes the title off the screen ("Not interested", or "Remove from My List").
 * The buttons sit below the art rather than over it, so a remote's Down key reaches them and Left/Right still
 * move from poster to poster.
 */
export function TitleCard ({ title, note, showType, badge, onRemove, removeLabel = 'Not interested', listed = false }: {
  title: TitleSummary
  note?: string
  showType?: boolean
  badge?: ReactNode
  onRemove?: () => void
  removeLabel?: string
  /** Shown on My List, where the remove button takes it off the list: no separate list toggle. */
  listed?: boolean
}) {
  const { type, id, name } = title
  const mark = useMark(id)
  return (
    <div className={`card${mark.rating === -1 ? ' is-disliked' : ''}`}>
      <PosterCard title={title} note={note} showType={showType} badge={badge} onOpen={() => showPreview(title)} />
      <div className="card-actions" role="group" aria-label={name}>
        {!listed && (
          <button type="button" className="card-action" aria-pressed={mark.inList} data-tip={mark.inList ? 'In My List' : 'My List'}
            aria-label={mark.inList ? `Remove ${name} from My List` : `Add ${name} to My List`}
            onClick={() => setTitleInList(type, id, !mark.inList)}>
            {mark.inList ? <Check aria-hidden /> : <Plus aria-hidden />}
          </button>
        )}
        <button type="button" className="card-action" aria-pressed={mark.rating === 1} data-tip={mark.rating === 1 ? 'Liked' : 'Like'}
          aria-label={`Like ${name}`} onClick={e => rateTitle(type, id, mark.rating === 1 ? 0 : 1, sourceOf(e))}>
          <ThumbsUp aria-hidden />
        </button>
        <button type="button" className="card-action" aria-pressed={mark.rating === -1} data-tip={mark.rating === -1 ? 'Disliked' : 'Dislike'}
          aria-label={`Dislike ${name}`} onClick={e => rateTitle(type, id, mark.rating === -1 ? 0 : -1, sourceOf(e))}>
          <ThumbsDown aria-hidden />
        </button>
        {onRemove && (
          <button type="button" className="card-action card-remove" data-tip={removeLabel} aria-label={`${removeLabel}: ${name}`} onClick={onRemove}>
            <X aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}
