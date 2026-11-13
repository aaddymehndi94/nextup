import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * A titled, horizontally scrolling shelf. `caption` is a short line under the title
 * (e.g. why a row is shown); `aside` sits at the head's far end (a link, a progress meter).
 * With a fine pointer, paddles at the edges page the shelf; keyboard and remote users move
 * through the items themselves.
 */
export function Row ({ title, caption, aside, children, variant = 'poster', id, className, onNearEnd, source }: {
  title: string
  caption?: ReactNode
  aside?: ReactNode
  children: ReactNode
  variant?: 'poster' | 'landscape' | 'square' | 'circle'
  id?: string
  className?: string
  /** Called when the shelf is scrolled to within a screen of its end (to load more titles into it). */
  onNearEnd?: () => void
  /** Recorded as where a title was opened from (see noteSource in storage.ts). */
  source?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  const nearEnd = useRef(onNearEnd)
  nearEnd.current = onNearEnd

  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 })
    if (el.scrollLeft > 0 && el.scrollLeft + 2 * el.clientWidth >= el.scrollWidth) nearEnd.current?.()
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    el.addEventListener('scroll', measure, { passive: true })
    return () => { ro.disconnect(); el.removeEventListener('scroll', measure) }
  }, [measure])

  const page = (dir: 1 | -1) => {
    const el = scroller.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
  }

  const headingId = id ?? `row-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section className={`row row-${variant}${className ? ` ${className}` : ''}`} aria-labelledby={headingId} data-source={source}>
      <header className="row-head">
        <div className="row-heading">
          <h2 className="row-title" id={headingId}>{title}</h2>
          {caption && <p className="row-caption">{caption}</p>}
        </div>
        {aside && <div className="row-aside">{aside}</div>}
      </header>
      <div className="row-frame" data-at-start={edges.start || undefined} data-at-end={edges.end || undefined}>
        <div ref={scroller} className="row-scroller">{children}</div>
        <button type="button" className="paddle start" tabIndex={-1} aria-label={`Scroll ${title} back`} hidden={edges.start} onClick={() => page(-1)}>
          <ChevronLeft aria-hidden />
        </button>
        <button type="button" className="paddle end" tabIndex={-1} aria-label={`Scroll ${title} forward`} hidden={edges.end} onClick={() => page(1)}>
          <ChevronRight aria-hidden />
        </button>
      </div>
    </section>
  )
}
