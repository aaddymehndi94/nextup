import { useEffect, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { MIN_RATINGS, type MinRating, setMinRating, useMinRating } from '../ratingFilter.ts'

const label = (n: MinRating) => (n ? `IMDb ${n}+` : 'Any rating')

/**
 * The masthead's rating filter: a button that opens a short menu (Any rating, IMDb 6+, 7+, 8+). While a minimum
 * is set the button is white and says it, so a thinner page is never a mystery. Arrow keys move through the menu;
 * Escape closes it.
 */
export function RatingFilter () {
  const min = useMinRating()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    ;(items().find(el => el.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus()
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const list = items()
      e.preventDefault()
      const i = list.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length
      list[next].focus()
    }
    document.addEventListener('pointerdown', onDown)
    const el = root.current
    el?.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); el?.removeEventListener('keydown', onKey) }
  }, [open])

  const choose = (n: MinRating) => { setMinRating(n); setOpen(false); button.current?.focus() }
  return (
    <div className="rating-filter" ref={root}>
      <button
        ref={button}
        type="button"
        className={`rating-button${min ? ' is-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={min ? `Showing IMDb ${min} and up. Change the rating filter` : 'Filter by IMDb rating'}
        onClick={() => setOpen(o => !o)}
      >
        IMDb{min > 0 && ` ${min}+`}
      </button>
      {open && (
        <div className="menu rating-menu" role="menu" id={menuId} aria-label="Show titles rated">
          <p className="rating-menu-head" aria-hidden>Show titles rated</p>
          {MIN_RATINGS.map(n => (
            <button key={n} type="button" role="menuitemradio" aria-checked={min === n} className="menu-item" onClick={() => choose(n)}>
              <span className="menu-label">{label(n)}</span>
              {min === n && <Check className="menu-check" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
