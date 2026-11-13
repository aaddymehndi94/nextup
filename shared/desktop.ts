// What the desktop app (desktop/src/preload.ts) offers the web page as `window.nexttuppDesktop`. A browser has none.

/** The song playing, for the system's "Now playing" notification with its Like button. */
export interface DesktopNowPlaying {
  /** Changes when the song does. */
  id: string
  title: string
  artist: string
  album?: string
  /** A small cover image URL (about 250 px). */
  cover?: string
  liked: boolean
  playing: boolean
}

/** Pressed in that notification. */
export type DesktopMusicAction = 'like' | 'unlike'

/**
 * A newer nexttupp. `downloading` and `ready` only where the app can install it itself (Linux .deb and AppImage,
 * Windows); elsewhere `available` with the page to download it from.
 */
export interface DesktopUpdate {
  state: 'available' | 'downloading' | 'ready' | 'installing' | 'failed'
  version: string
  current: string
  /** The release page (what's new). */
  url: string
  /** 0..1 while downloading. */
  progress?: number
  /** Installing asks for the computer's password (Linux .deb). */
  needsPassword?: boolean
  error?: string
}

export interface DesktopBridge {
  nowPlaying (info: DesktopNowPlaying | null): void
  /** `id` is the song the notification showed. */
  onMusicAction (fn: (action: DesktopMusicAction, id: string) => void): () => void
  /** Called now with what's known, and again whenever it changes (null: up to date). */
  onUpdate (fn: (update: DesktopUpdate | null) => void): () => void
  /** Downloads it if needed, installs it and restarts nexttupp. */
  installUpdate (): void
  /** Asks GitHub now; resolves with the result (null: this is the latest). */
  checkForUpdate (): Promise<DesktopUpdate | null>
}
