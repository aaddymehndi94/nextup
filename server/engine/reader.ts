import type { Torrent, TorrentFile } from 'webtorrent'

// Replaces webtorrent's FileIterator for streaming. Two problems with the stock iterator:
//  1. It selects "from here to the end of the file" at a fixed priority, and the piece picker serves
//     selections in insertion order, so an abandoned read (ffmpeg's header connection, a cancelled
//     browser range) keeps every peer busy while the seek target waits.
//  2. Every reader looks the same, so there is no way to say "the newest request matters most".
// This reader keeps a bounded high-priority window just ahead of the read position, leaves the rest
// of the range to background priority, and can be demoted when a newer reader takes over.
// It relies on webtorrent's internal _select/_deselect stream selections (the same calls FileIterator
// makes); webtorrent is pinned in package.json for that reason.

interface InternalTorrent extends Torrent {
  _select(from: number, to: number, priority: number, notify: null, isStreamSelection: boolean): void
  _deselect(from: number, to: number, isStreamSelection: boolean): void
  critical(from: number, to: number): void
  store: { get(index: number, opts: { offset: number; length: number }, cb: (err: Error | null, buf?: Uint8Array) => void): void }
}

const HIGH = 2
const LOW = 0
/** Bytes ahead of the read position that are fetched urgently. */
const WINDOW_BYTES = 48 * 1024 * 1024
/** A glance (one still for the quick look) needs one keyframe: a few MB, not a stream's worth. */
const GLANCE_BYTES = 4 * 1024 * 1024
/** Pieces marked critical (may steal in-flight blocks from slow peers). */
const CRITICAL_PIECES = 3

interface Sel { from: number; to: number; priority: number }

export class StreamReader {
  private readonly torrent: InternalTorrent
  private readonly startPiece: number
  private readonly endPiece: number
  private readonly windowPieces: number
  private readonly glance: boolean
  private piece: number
  private offsetInPiece: number
  private remaining: number
  private active = true
  private destroyed = false
  private selections: Sel[] = []
  private wake: (() => void) | null = null
  private readonly onVerified = (i: number) => { if (i === this.piece) this.wake?.() }

  /** `glance`: a short look (a still), so a small urgent window and no background tail. */
  constructor (torrent: Torrent, file: TorrentFile, start: number, end: number, opts: { glance?: boolean } = {}) {
    this.torrent = torrent as InternalTorrent
    const pl = torrent.pieceLength
    this.startPiece = Math.floor((file.offset + start) / pl)
    this.endPiece = Math.floor((file.offset + end) / pl)
    this.piece = this.startPiece
    this.offsetInPiece = (file.offset + start) - this.startPiece * pl
    this.remaining = end - start + 1
    this.glance = Boolean(opts.glance)
    this.windowPieces = this.glance ? Math.max(2, Math.ceil(GLANCE_BYTES / pl)) : Math.max(8, Math.ceil(WINDOW_BYTES / pl))
    this.torrent.on('verified', this.onVerified)
    this.reselect()
  }

  /** Newest reader on a file gets the urgent window; older ones fall behind it. */
  setActive (active: boolean): void {
    if (this.active === active || this.destroyed) return
    this.active = active
    this.reselect()
  }

  private reselect (): void {
    if (this.destroyed || this.torrent.destroyed) return
    const next: Sel[] = []
    const windowEnd = Math.min(this.piece + this.windowPieces - 1, this.endPiece)
    next.push({ from: this.piece, to: windowEnd, priority: this.active ? HIGH : LOW })
    // Only the active reader keeps a background tail; an abandoned reader shouldn't pull the whole file.
    if (this.active && !this.glance && windowEnd < this.endPiece) next.push({ from: windowEnd + 1, to: this.endPiece, priority: LOW })
    for (const s of next) this.torrent._select(s.from, s.to, s.priority, null, true)
    for (const s of this.selections) this.torrent._deselect(s.from, s.to, true)
    this.selections = next
  }

  async * [Symbol.asyncIterator] (): AsyncGenerator<Uint8Array> {
    const pl = this.torrent.pieceLength
    try {
      while (this.remaining > 0 && !this.destroyed) {
        if (this.torrent.destroyed) return
        // Slide the urgent window forward once we've consumed a quarter of it.
        if (this.piece - this.selections[0].from >= this.windowPieces / 4) this.reselect()

        if (!this.torrent.bitfield.get(this.piece)) {
          this.torrent.critical(this.piece, Math.min(this.piece + CRITICAL_PIECES - 1, this.endPiece))
          await new Promise<void>(resolve => {
            this.wake = resolve
            if (this.torrent.bitfield.get(this.piece) || this.destroyed) resolve()
          })
          this.wake = null
          if (this.destroyed) return
        }

        const length = Math.min(this.remaining, pl - this.offsetInPiece)
        const buf = await new Promise<Uint8Array>((resolve, reject) => {
          this.torrent.store.get(this.piece, { offset: this.offsetInPiece, length }, (err, b) => err ? reject(err) : resolve(b!))
        })
        this.remaining -= length
        this.offsetInPiece = 0
        this.piece++
        yield buf
      }
    } finally {
      this.destroy()
    }
  }

  destroy (): void {
    if (this.destroyed) return
    this.destroyed = true
    this.torrent.off('verified', this.onVerified)
    this.wake?.()
    if (!this.torrent.destroyed) for (const s of this.selections) this.torrent._deselect(s.from, s.to, true)
    this.selections = []
  }
}
