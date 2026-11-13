import { createContext, useContext, useEffect, useState } from 'react'

/**
 * False while this page is kept alive behind another (main.tsx): it stays mounted, hidden, so Back finds it
 * as it was. Things that act on the whole window (the tab title, keyboard shortcuts) wait until it's shown.
 */
export const PageActive = createContext(true)
export const usePageActive = () => useContext(PageActive)

/** Sets the tab title: "Title · nexttupp", or just the brand. */
export function useDocumentTitle (title?: string) {
  const active = usePageActive()
  useEffect(() => {
    if (active) document.title = title ? `${title} · nexttupp` : 'nexttupp'
  }, [title, active])
}

/** True once the page has scrolled past `threshold` px; drives the masthead's solid state. */
export function useScrolled (threshold = 8) {
  const [scrolled, setScrolled] = useState(() => window.scrollY > threshold)
  useEffect(() => {
    let frame = 0
    const on = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setScrolled(window.scrollY > threshold))
    }
    window.addEventListener('scroll', on, { passive: true })
    return () => { window.removeEventListener('scroll', on); cancelAnimationFrame(frame) }
  }, [threshold])
  return scrolled
}

/**
 * Tracks whether an <img> with this `src` has loaded, so artwork can fade in instead of popping.
 * Keyed by src (not a reset effect), so a cached image that loads before effects run still shows.
 */
export function useLoaded (src?: string) {
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined)
  return [src !== undefined && loadedSrc === src, () => setLoadedSrc(src)] as const
}
