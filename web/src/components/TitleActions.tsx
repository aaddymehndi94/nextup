import type { ComponentType } from 'react'
import { Check, Eye, EyeOff, Plus, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { TitleActions as Actions } from '../taste.ts'

/** A 3rem round toggle beside Play; pressed turns it solid white. The label shows as a tip on hover/focus. */
function RoundToggle ({ pressed, label, tip, icon: Icon, onClick, disabled }: {
  pressed: boolean
  label: string
  tip: string
  icon: ComponentType<{ 'aria-hidden'?: boolean }>
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" className="round-button" aria-pressed={pressed} aria-label={label} data-tip={tip} onClick={onClick} disabled={disabled}>
      <Icon aria-hidden />
    </button>
  )
}

/** My List, Like and Dislike, for the hero's action row (after Play). The billboard shows My List only. */
export function TasteButtons ({ actions, name, listOnly = false }: { actions: Actions; name: string; listOnly?: boolean }) {
  const s = actions.state
  const ready = s !== null
  return (
    <>
      <RoundToggle
        pressed={!!s?.inList}
        label={s?.inList ? `Remove ${name} from My List` : `Add ${name} to My List`}
        tip={s?.inList ? 'In My List' : 'My List'}
        icon={s?.inList ? Check : Plus}
        disabled={!ready}
        onClick={() => actions.setInList(!s!.inList)}
      />
      {!listOnly && <RoundToggle pressed={s?.rating === 1} label="Like" tip={s?.rating === 1 ? 'Liked' : 'Like'} icon={ThumbsUp} disabled={!ready} onClick={() => actions.rate(s!.rating === 1 ? 0 : 1)} />}
      {!listOnly && <RoundToggle pressed={s?.rating === -1} label="Dislike" tip={s?.rating === -1 ? 'Disliked' : 'Dislike'} icon={ThumbsDown} disabled={!ready} onClick={() => actions.rate(s!.rating === -1 ? 0 : -1)} />}
    </>
  )
}

/** The quieter "not this" choices, and what was chosen, with a way back. */
export function DismissLine ({ actions }: { actions: Actions }) {
  const s = actions.state
  if (!s) return null
  if (s.dismissed) {
    return (
      <p className="hero-quiet is-set" role="status">
        <span>{s.dismissed === 'not_interested' ? 'Not interested. It won’t be recommended to you.' : 'Marked as already seen. It won’t be recommended.'}</span>
        <button type="button" className="link" onClick={() => actions.dismiss(null)}>Undo</button>
      </p>
    )
  }
  return (
    <p className="hero-quiet">
      <button type="button" className="text-button" onClick={() => actions.dismiss('not_interested')}>
        <EyeOff aria-hidden />Not interested
      </button>
      <button type="button" className="text-button" onClick={() => actions.dismiss('seen')}>
        <Eye aria-hidden />Already seen
      </button>
    </p>
  )
}
