import { useEffect, useRef, useState } from 'react'
import { Ellipsis, Heart, ListEnd, ListPlus, Play, Radio, ThumbsDown, User } from 'lucide-react'
import type { MusicArtist, MusicMixCard, MusicTrack } from '../../../shared/music.ts'
import { artSize } from '../../../shared/music.ts'
import { navigate, onLinkClick } from '../router.ts'
import { addToQueue, playList, playNext, playRadio, rate, usePlayer } from './player.ts'

// Small pieces the music pages share: artwork, song rows, cards and the song menu.

export const coverOf = (t: MusicTrack | undefined) => t?.album?.cover ?? t?.artist.picture
/** Why a song is in a mix, unless it only repeats who sings it. */
export const whyOf = (t: MusicTrack): string | undefined => t.why && t.why !== (t.credit ?? t.artist.name) && t.why !== t.artist.name ? t.why : undefined

/**
 * A cover or a picture that fades in once it has loaded. `low` names a small size the page has most likely
 * already fetched (song rows and the mini player use 120), shown underneath so a big cover is never a blank square.
 */
export function Art ({ src, size, alt = '', round = false, className = '', low }: { src?: string; size: number; alt?: string; round?: boolean; className?: string; low?: number }) {
  const [loaded, setLoaded] = useState<string>()
  const url = artSize(src, size)
  const under = low && src ? artSize(src, low) : undefined
  return (
    <span className={`m-art${round ? ' round' : ''}${className ? ` ${className}` : ''}`} style={under ? { backgroundImage: `url("${under}")` } : undefined}>
      {url && <img key={url} src={url} alt={alt} loading={low ? 'eager' : 'lazy'} decoding="async" data-loaded={loaded === url || undefined} onLoad={() => setLoaded(url)} />}
    </span>
  )
}

/** Four covers in a square, or one when that's all there is. */
export function Collage ({ covers, size }: { covers: string[]; size: number }) {
  if (covers.length < 4) return <Art src={covers[0]} size={size} />
  return (
    <span className="m-art m-collage">
      {covers.slice(0, 4).map(c => <img key={c} src={artSize(c, Math.round(size / 2))} alt="" loading="lazy" decoding="async" data-loaded />)}
    </span>
  )
}

/** Three bars that move while this is the song playing. */
export function Bars ({ live }: { live: boolean }) {
  return <span className={`m-bars${live ? ' live' : ''}`} aria-hidden><i /><i /><i /></span>
}

export const duration = (s: number) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '')

export function LikeButton ({ track, className = 'm-icon' }: { track: MusicTrack; className?: string }) {
  const { ratings } = usePlayer()
  const liked = ratings[track.id] === 1
  return (
    <button type="button" className={`${className}${liked ? ' on' : ''}`} aria-pressed={liked} aria-label={liked ? `Unlike ${track.title}` : `Like ${track.title}`}
      onClick={e => { e.stopPropagation(); void rate(track, liked ? 0 : 1) }}>
      <Heart aria-hidden fill={liked ? 'currentColor' : 'none'} />
    </button>
  )
}

/** The ⋯ menu on a song: play next, add to queue, its radio, its artist, not for me. */
export function SongMenu ({ track, align = 'end' }: { track: MusicTrack; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [open])
  const item = (icon: React.ReactNode, label: string, fn: () => void) => (
    <button type="button" role="menuitem" className="m-menu-item" onClick={e => { e.stopPropagation(); setOpen(false); fn() }}>{icon}{label}</button>
  )
  return (
    <div className="m-menu-wrap" ref={box}>
      <button type="button" className="m-icon" aria-label={`More for ${track.title}`} aria-haspopup="menu" aria-expanded={open} onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
        <Ellipsis aria-hidden />
      </button>
      {open && (
        <div className={`m-menu ${align}`} role="menu">
          {item(<ListPlus aria-hidden />, 'Play next', () => playNext(track))}
          {item(<ListEnd aria-hidden />, 'Add to queue', () => addToQueue(track))}
          {item(<Radio aria-hidden />, 'Start song radio', () => void playRadio({ track: track.id }, `${track.title} radio`))}
          {item(<User aria-hidden />, `Go to ${track.artist.name}`, () => navigate(`/music/artist/${track.artist.id}`))}
          {item(<ThumbsDown aria-hidden />, 'Not for me', () => void rate(track, -1))}
        </div>
      )}
    </div>
  )
}

/** Songs as rows: tap one to play the list from there. */
export function SongList ({ tracks, from, numbered = false, showWhy = false, then }: {
  tracks: MusicTrack[]
  from: string
  numbered?: boolean
  showWhy?: boolean
  /** What to continue with after the list (default: a radio from its last song). */
  then?: Parameters<typeof playList>[3]
}) {
  const { queue, index, playing } = usePlayer()
  const now = queue[index]?.id
  return (
    <ol className="m-songs">
      {tracks.map((t, i) => {
        const isNow = t.id === now
        return (
          <li key={`${t.id}-${i}`} className={`m-song${isNow ? ' now' : ''}`}>
            <button type="button" className="m-song-main" onClick={() => playList(tracks, i, from, then)} aria-label={`Play ${t.title} by ${t.credit ?? t.artist.name}`}>
              {numbered
                ? <span className="m-song-n">{isNow ? <Bars live={playing} /> : i + 1}</span>
                : (
                  <span className="m-song-art">
                    <Art src={coverOf(t)} size={120} />
                    {isNow && <span className="m-song-playing"><Bars live={playing} /></span>}
                  </span>
                  )}
              <span className="m-song-text">
                <span className="m-song-title">{t.title}{t.explicit && <abbr className="m-e" title="Explicit">E</abbr>}</span>
                <span className="m-song-sub">{t.credit ?? t.artist.name}{showWhy && whyOf(t) && <span className="m-song-why"> · {whyOf(t)}</span>}</span>
              </span>
            </button>
            <span className="m-song-time">{duration(t.duration)}</span>
            <LikeButton track={t} />
            <SongMenu track={t} />
          </li>
        )
      })}
    </ol>
  )
}

export function MixCard ({ mix, onPlay }: { mix: MusicMixCard; onPlay: () => void }) {
  return (
    <div className="m-card">
      <a href={`/music/mix/${mix.id}`} onClick={onLinkClick} className="m-card-link">
        <span className="m-card-art">
          <Collage covers={mix.covers} size={400} />
          <span className="m-card-label"><span>{mix.title}</span></span>
        </span>
        <span className="m-card-sub">{mix.subtitle}</span>
      </a>
      <button type="button" className="m-card-play" aria-label={`Play ${mix.title}`} onClick={onPlay}><Play aria-hidden fill="currentColor" /></button>
    </div>
  )
}

export function SongCard ({ track, onPlay }: { track: MusicTrack; onPlay: () => void }) {
  const { queue, index } = usePlayer()
  const isNow = queue[index]?.id === track.id
  return (
    <div className="m-card">
      <button type="button" className="m-card-link" onClick={onPlay} aria-label={`Play ${track.title} by ${track.credit ?? track.artist.name}`}>
        <span className="m-card-art"><Art src={coverOf(track)} size={400} /></span>
        <span className="m-card-name">{track.title}</span>
        <span className="m-card-sub">{isNow ? 'Playing now' : track.credit ?? track.artist.name}</span>
      </button>
    </div>
  )
}

export function ArtistCard ({ artist, caption, onClick, pressed }: { artist: MusicArtist; caption?: string; onClick?: () => void; pressed?: boolean }) {
  const inner = (
    <>
      <span className="m-card-art"><Art src={artist.picture} size={400} round />{pressed && <span className="m-picked" aria-hidden><Heart fill="currentColor" /></span>}</span>
      <span className="m-card-name">{artist.name}</span>
      {caption && <span className="m-card-sub">{caption}</span>}
    </>
  )
  return (
    <div className="m-card m-card-artist">
      {onClick
        ? <button type="button" className="m-card-link" aria-pressed={pressed} onClick={onClick}>{inner}</button>
        : <a className="m-card-link" href={`/music/artist/${artist.id}`} onClick={onLinkClick}>{inner}</a>}
    </div>
  )
}

export function AlbumCard ({ album }: { album: { id: string; title: string; cover?: string; year?: number; kind?: string; artist?: string } }) {
  return (
    <div className="m-card">
      <a className="m-card-link" href={`/music/album/${album.id}`} onClick={onLinkClick}>
        <span className="m-card-art"><Art src={album.cover} size={400} /></span>
        <span className="m-card-name">{album.title}</span>
        <span className="m-card-sub">{[album.kind, album.year, album.artist].filter(Boolean).join(' · ')}</span>
      </a>
    </div>
  )
}
