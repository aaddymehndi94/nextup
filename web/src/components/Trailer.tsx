import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import type { MediaType, TrailerStatus } from '../../../shared/types.ts'
import { request } from '../api.ts'
import { usePageActive } from '../hooks.ts'
import { usePlayer } from '../music/player.ts'
import { useLocation } from '../router.ts'

// The title's trailer, muted and looping behind the hero (title page) or the billboard (home), from the
// computer's copy (server/trailers.ts). It fades in over the backdrop once it can play and the page has
// settled, and back to the picture whenever it pauses: out of view, in a hidden tab, while music plays, or
// behind the quick-view popup. With reduced motion it doesn't play; the Trailer button (the popup) still does.
// No trailer, or not yet: the backdrop, and nothing else.
//
//   const trailer = useTrailer(type, id)
//   <TrailerVideo trailer={trailer} />    where the backdrop is, under the shade
//   <TrailerButton trailer={trailer} />   in the action row: sound on/off while it plays

const POLL_MS = 4000
/** The first download can take minutes on a slow line; after this the next visit gets it. */
const POLL_FOR_MS = 3 * 60_000
const SETTLE_MS = 1500

function useMedia (query: string | undefined): boolean {
  const get = () => !query || typeof matchMedia !== 'function' || matchMedia(query).matches
  const [on, setOn] = useState(get)
  useEffect(() => {
    if (!query || typeof matchMedia !== 'function') return
    const mq = matchMedia(query)
    const update = () => setOn(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return on
}

export interface Trailer {
  src: string | null
  ref: (el: HTMLVideoElement | null) => void
  /** Ready to play (canplay) and not broken. */
  available: boolean
  /** Playing, faded in over the backdrop. */
  showing: boolean
  muted: boolean
  setMuted: (muted: boolean) => void
  /** Reduced motion: the trailer plays only when asked. */
  reduced: boolean
  asked: boolean
  setAsked: (asked: boolean) => void
}

/** `media`: a media query the screen must match (the billboard has none on phones, where it shows the poster). */
export function useTrailer (type: MediaType, id: string, opts: { enabled?: boolean; media?: string } = {}): Trailer {
  const fits = useMedia(opts.media)
  const enabled = (opts.enabled ?? true) && fits
  const reduced = useMedia('(prefers-reduced-motion: reduce)')
  const music = usePlayer().playing
  const [src, setSrc] = useState<string | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [canPlay, setCanPlay] = useState(false)
  const [failed, setFailed] = useState(false)
  const [settled, setSettled] = useState(false)
  const [inView, setInView] = useState(false)
  const [tabShown, setTabShown] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  const [showing, setShowing] = useState(false)
  const [muted, setMuted] = useState(true)
  const [asked, setAsked] = useState(false)
  const last = useRef<HTMLVideoElement | null>(null)

  // Ask the computer for it; while it's being fetched, ask again for a while. Errors stay quiet.
  useEffect(() => {
    setSrc(null); setCanPlay(false); setFailed(false); setSettled(false); setShowing(false); setMuted(true); setAsked(false)
    if (!enabled) return
    let live = true
    let timer: number | undefined
    const began = Date.now()
    const ask = () => {
      request<TrailerStatus>(`/api/trailer/${type}/${id}`)
        .then(s => {
          if (!live) return
          if (s.state === 'ready') setSrc(s.url)
          else if (s.state === 'preparing' && Date.now() - began < POLL_FOR_MS) timer = window.setTimeout(ask, POLL_MS)
        })
        .catch(() => {})
    }
    ask()
    return () => { live = false; clearTimeout(timer) }
  }, [type, id, enabled])

  // The page has settled once the backdrop beside the video is in; the trailer comes a moment after that.
  useEffect(() => {
    if (!video || !src) return
    setSettled(false)
    let timer: number | undefined
    const arm = () => { clearTimeout(timer); timer = window.setTimeout(() => setSettled(true), SETTLE_MS) }
    const img = video.parentElement?.querySelector('img')
    if (img && !img.complete) {
      img.addEventListener('load', arm, { once: true })
      img.addEventListener('error', arm, { once: true })
    } else arm()
    return () => {
      clearTimeout(timer)
      img?.removeEventListener('load', arm)
      img?.removeEventListener('error', arm)
    }
  }, [video, src])

  useEffect(() => {
    const update = () => setTabShown(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  // The <video>: set up when it appears; when it goes (leaving the page), drop its source so the download stops.
  const ref = useCallback((el: HTMLVideoElement | null) => {
    const old = last.current
    if (old && old !== el) { old.pause(); old.removeAttribute('src'); old.load() }
    last.current = el
    if (el) {
      el.muted = true
      // No browser-made cast or picture-in-picture: Chrome on Android would put its own cast button on it.
      el.disableRemotePlayback = true
      el.disablePictureInPicture = true
      el.setAttribute('x-webkit-airplay', 'deny')
    }
    setVideo(el)
  }, [])

  useEffect(() => {
    if (!video) return
    const onCanPlay = () => setCanPlay(true)
    const onPlaying = () => setShowing(true)
    const onPause = () => setShowing(false)
    const onError = () => { setFailed(true); setShowing(false) }
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) setCanPlay(true)
    const io = new IntersectionObserver(([e]) => setInView(e.intersectionRatio >= 0.25), { threshold: [0, 0.25, 0.5] })
    io.observe(video)
    return () => {
      io.disconnect()
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('error', onError)
    }
  }, [video])

  useEffect(() => { if (video) video.muted = muted }, [video, muted])

  // Not behind the quick-view popup (its trailer has the sound), nor on a page kept hidden behind another.
  const covered = useLocation().preview !== null || !usePageActive()
  const play = canPlay && !failed && settled && inView && tabShown && !music && !covered && (!reduced || asked)
  useEffect(() => {
    if (!video || !src) return
    if (play) video.play().catch(() => { /* not allowed here: the picture stays */ })
    else video.pause()
  }, [video, src, play])

  return { src, ref, available: Boolean(src) && canPlay && !failed, showing, muted, setMuted, reduced, asked, setAsked }
}

export function TrailerVideo ({ trailer: t }: { trailer: Trailer }) {
  if (!t.src) return null
  return (
    <video
      ref={t.ref}
      className={`trailer-video${t.showing ? ' is-on' : ''}`}
      src={t.src}
      muted={t.muted}
      playsInline
      loop
      preload="auto"
      disablePictureInPicture
      disableRemotePlayback
      aria-hidden
      tabIndex={-1}
    />
  )
}

/** Sound on and off while it plays. */
export function TrailerButton ({ trailer: t }: { trailer: Trailer }) {
  if (!t.available || !t.showing) return null
  return (
    <button
      type="button"
      className="round-button trailer-button"
      aria-label={t.muted ? 'Turn trailer sound on' : 'Turn trailer sound off'}
      data-tip={t.muted ? 'Unmute' : 'Mute'}
      onClick={() => t.setMuted(!t.muted)}
    >
      {t.muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
    </button>
  )
}
