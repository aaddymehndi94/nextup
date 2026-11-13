// "Now playing" as a system notification with a Like button. The system's media controls (MPRIS on Linux: the
// top bar's media widget and the lock screen) come from the page's Media Session, which has no Like, so this
// sits beside them. Low urgency and never expiring: GNOME files it in the notification list without a banner,
// and it's replaced in place as songs change. Elsewhere it only appears while the window isn't focused.
import { Notification, nativeImage, net, type NativeImage } from 'electron'
import type { DesktopMusicAction, DesktopNowPlaying } from '../../shared/desktop.ts'

export class NowPlayingNotice {
  private shown: Notification | null = null
  /** The song and Like state the notification shows, so pause/play and repeats don't redraw it. */
  private shownId: string | null = null
  private shownKey: string | null = null
  private covers = new Map<string, NativeImage>()
  private seq = 0

  constructor (private readonly opts: {
    icon: string
    onAction: (action: DesktopMusicAction, id: string) => void
    onOpen: () => void
    /** True when a new song shouldn't announce itself (the window is in front, off Linux). */
    quiet: () => boolean
  }) {}

  update (info: DesktopNowPlaying | null): void {
    if (!info) return this.close()
    if (!Notification.isSupported()) return
    if (`${info.id}:${info.liked}` === this.shownKey) return
    // A new song is shown once it plays; a Like or Unlike redraws the one already shown.
    if (info.id !== this.shownId && (!info.playing || this.opts.quiet())) return
    void this.show(info)
  }

  close (): void {
    this.seq++
    this.shown?.close()
    this.shown = null
    this.shownId = this.shownKey = null
  }

  private async show (info: DesktopNowPlaying): Promise<void> {
    const mine = ++this.seq
    const cover = await this.cover(info.cover)
    if (mine !== this.seq) return
    const n = new Notification({
      title: info.title,
      body: [info.artist, info.album].filter(Boolean).join(' · '),
      icon: cover ?? this.opts.icon,
      silent: true,
      urgency: 'low',
      timeoutType: 'never',
      actions: [{ type: 'button', text: info.liked ? 'Unlike' : 'Like' }],
    })
    n.on('action', () => this.opts.onAction(info.liked ? 'unlike' : 'like', info.id))
    n.on('click', () => this.opts.onOpen())
    // Dismissed by hand: the next song brings it back.
    n.on('close', () => { if (this.shown === n) this.shown = null })
    this.shown?.close()
    // Kept referenced: a collected Notification no longer hears its buttons.
    this.shown = n
    this.shownId = info.id
    this.shownKey = `${info.id}:${info.liked}`
    n.show()
  }

  /** The cover as an image (at most 4 s: the CDN can be slow, and the notification shouldn't wait on it). */
  private async cover (url: string | undefined): Promise<NativeImage | null> {
    if (!url || !url.startsWith('https://')) return null
    const hit = this.covers.get(url)
    if (hit) return hit
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return null
      const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
      if (img.isEmpty()) return null
      this.covers.set(url, img)
      if (this.covers.size > 30) this.covers.delete(this.covers.keys().next().value!)
      return img
    } catch {
      return null
    }
  }
}
