// YouTube's player for trailers in the quick-view popup (components/Preview.tsx). YouTube streams them at a
// quality the line can keep up with, so a trailer starts in a second or two with nothing downloaded first.
// Its iframe API script is loaded once, when it's first needed.

export interface YouTubePlayer {
  playVideo (): void
  pauseVideo (): void
  loadVideoById (id: string): void
  destroy (): void
}

export interface YouTubeEvent { data: number; target: YouTubePlayer }

interface YouTubeApi {
  Player: new (el: HTMLElement, opts: {
    host?: string
    videoId: string
    width?: string
    height?: string
    playerVars?: Record<string, string | number>
    events?: Partial<Record<'onReady' | 'onStateChange' | 'onError', (e: YouTubeEvent) => void>>
  }) => YouTubePlayer
}

declare global {
  interface Window { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void }
}

/** Player states, from the iframe API. */
export const YT_ENDED = 0
export const YT_PLAYING = 1

let api: Promise<YouTubeApi> | null = null

export function loadYouTube (): Promise<YouTubeApi> {
  api ??= new Promise<YouTubeApi>((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return }
    const before = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { before?.(); if (window.YT) resolve(window.YT) }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.async = true
    s.onerror = () => { api = null; s.remove(); reject(new Error('YouTube didn’t load')) }
    document.head.append(s)
  })
  return api
}

let warmed = false

/** Opens the connections and loads the player script ahead of a click (on hover): it saves a second. */
export function warmYouTube () {
  if (warmed) return
  warmed = true
  for (const href of ['https://www.youtube-nocookie.com', 'https://i.ytimg.com']) {
    const link = document.createElement('link')
    link.rel = 'preconnect'
    link.href = href
    document.head.append(link)
  }
  loadYouTube().catch(() => { warmed = false })
}
