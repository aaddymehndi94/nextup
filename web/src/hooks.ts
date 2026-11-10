import { useEffect, useState } from 'react'

/** Sets the tab title: "Title · nexttupp", or just the brand. */
export function useDocumentTitle (title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · nexttupp` : 'nexttupp'
  }, [title])
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
