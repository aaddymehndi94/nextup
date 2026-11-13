import { useEffect, useState } from 'react'
import { Heart, Play, Radio, Shuffle } from 'lucide-react'
import type { MusicAlbum, MusicArtistPage, MusicMix, MusicTrack } from '../../../shared/music.ts'
import { artSize } from '../../../shared/music.ts'
import { Row } from '../components/Row.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { useAmbient } from '../ambient.ts'
import { useDocumentTitle } from '../hooks.ts'
import { musicApi } from '../music/api.ts'
import { joinCast, playList, playRadio } from '../music/player.ts'
import { AlbumCard, Art, ArtistCard, Collage, coverOf, SongList } from '../music/ui.tsx'
import { toast } from '../toast.ts'

// A mix, an album or an artist: its picture, one white Play, and its songs.

type Kind = 'mix' | 'album' | 'artist'
type Data = { kind: 'mix'; data: MusicMix } | { kind: 'album'; data: MusicAlbum } | { kind: 'artist'; data: MusicArtistPage }

const shuffled = <T,>(list: T[]): T[] => {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

const minutes = (tracks: MusicTrack[]) => {
  const m = Math.round(tracks.reduce((s, t) => s + (t.duration || 0), 0) / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

export function MusicCollection ({ kind, id }: { kind: Kind; id: string }) {
  const [load, setLoad] = useState<{ state: 'loading' } | { state: 'ok'; d: Data } | { state: 'error'; message: string }>({ state: 'loading' })
  const [showAll, setShowAll] = useState(false)
  const [artistRating, setArtistRating] = useState<1 | -1 | 0>(0)

  useEffect(() => {
    joinCast()
    const p: Promise<Data> = kind === 'mix' ? musicApi.mix(id).then(data => ({ kind, data }))
      : kind === 'album' ? musicApi.album(id).then(data => ({ kind, data }))
        : musicApi.artist(id).then(data => ({ kind, data }))
    p.then(d => { setLoad({ state: 'ok', d }); if (d.kind === 'artist') setArtistRating(d.data.rating) })
      .catch(err => setLoad({ state: 'error', message: (err as Error).message }))
  }, [kind, id])

  const d = load.state === 'ok' ? load.d : null
  const title = !d ? undefined : d.kind === 'artist' ? d.data.artist.name : d.data.title
  useDocumentTitle(title)
  // The page takes on the cover's colour (a mix's collage uses its first song's cover).
  const art = !d ? undefined : d.kind === 'artist' ? d.data.artist.picture : d.kind === 'album' ? d.data.cover : d.data.tracks[0]?.album?.cover
  useAmbient(artSize(art, 120))

  if (load.state === 'loading') {
    return (
      <main className="m-collection">
        <TopBar solid up="/music" />
        <header className="m-hero"><span className="m-hero-art skeleton" /><div className="m-hero-text"><span className="skeleton-line" /><span className="skeleton-line short" /></div></header>
      </main>
    )
  }
  if (load.state === 'error' || !d) {
    return (
      <main className="m-collection">
        <TopBar solid up="/music" />
        <div className="m-page"><div className="empty"><p className="empty-title">This didn’t load</p><p className="notice">{load.state === 'error' ? load.message : ''}</p></div></div>
      </main>
    )
  }

  const tracks = d.kind === 'artist' ? d.data.top : d.data.tracks
  const from = d.kind === 'artist' ? `${d.data.artist.name}: popular songs` : d.data.title
  const then = d.kind === 'mix' && ['daily', 'discover', 'repeat', 'liked', 'ai', 'mood'].includes(d.data.kind) ? {} : d.kind === 'artist' ? { artist: d.data.artist.id } : undefined
  const play = (list: MusicTrack[]) => { if (list.length) playList(list, 0, from, then) }
  const picture = d.kind === 'artist' ? d.data.artist.picture : d.kind === 'album' ? d.data.cover : undefined
  const meta = d.kind === 'mix'
    ? [d.data.subtitle, d.data.model ? `Made by ${d.data.model}` : '', `${tracks.length} songs, ${minutes(tracks)}`]
    : d.kind === 'album'
      ? [[d.data.artist.name, d.data.year].filter(Boolean).join(' · '), `${tracks.length} songs, ${minutes(tracks)}`]
      : []

  const likeArtist = async () => {
    if (d.kind !== 'artist') return
    const next = artistRating === 1 ? 0 : 1
    setArtistRating(next)
    try {
      await musicApi.rate('artist', d.data.artist.id, next)
      toast(next ? `You like ${d.data.artist.name}. Your mixes will have more of them.` : `Removed ${d.data.artist.name} from your artists.`)
    } catch (err) {
      setArtistRating(artistRating)
      toast((err as Error).message)
    }
  }

  return (
    <main className={`m-collection kind-${d.kind}`}>
      <TopBar solid up="/music" />
      <header className="m-hero">
        {picture && <div className="m-hero-glow" aria-hidden><Art src={picture} size={120} /></div>}
        <div className={`m-hero-art${d.kind === 'artist' ? ' round' : ''}`}>
          {d.kind === 'mix'
            ? <Collage covers={d.data.covers.length ? d.data.covers : tracks.map(coverOf).filter((c): c is string => Boolean(c)).slice(0, 4)} size={600} />
            : <Art src={picture} size={600} low={120} round={d.kind === 'artist'} />}
        </div>
        <div className="m-hero-text">
          <h1 className="m-hero-title">{title}</h1>
          {meta.filter(Boolean).map((line, i) => <p key={i} className={i ? 'm-hero-meta' : 'm-hero-sub'}>{line}</p>)}
          <div className="m-hero-actions">
            <button type="button" className="button primary" disabled={!tracks.length} onClick={() => play(tracks)}><Play aria-hidden fill="currentColor" />Play</button>
            <button type="button" className="round-button" disabled={!tracks.length} onClick={() => play(shuffled(tracks))} aria-label="Shuffle"><Shuffle aria-hidden /></button>
            {d.kind === 'artist' && (
              <>
                <button type="button" className="round-button" onClick={() => void playRadio({ artist: d.data.artist.id }, `${d.data.artist.name} radio`)} aria-label={`${d.data.artist.name} radio`}><Radio aria-hidden /></button>
                <button type="button" className="round-button" aria-pressed={artistRating === 1} onClick={() => void likeArtist()} aria-label={artistRating === 1 ? `Unlike ${d.data.artist.name}` : `Like ${d.data.artist.name}`}>
                  <Heart aria-hidden fill={artistRating === 1 ? 'currentColor' : 'none'} />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="m-page">
        {d.kind === 'artist' && <h2 className="row-title m-list-title">Popular</h2>}
        {tracks.length
          ? <SongList tracks={d.kind === 'artist' && !showAll ? tracks.slice(0, 10) : tracks} from={from} numbered={d.kind === 'album'} showWhy={d.kind === 'mix'} then={then} />
          : <p className="notice">{d.kind === 'mix' && d.data.kind === 'liked' ? 'Songs you like show up here. Tap the heart on any song.' : 'No songs here yet.'}</p>}
        {d.kind === 'artist' && tracks.length > 10 && (
          <button type="button" className="row-link m-more" onClick={() => setShowAll(s => !s)}>{showAll ? 'Show fewer' : `Show all ${tracks.length}`}</button>
        )}
        {d.kind === 'artist' && d.data.albums.length > 0 && (
          <Row title="Albums and singles" variant="square" id="m-albums">
            {d.data.albums.map(a => <AlbumCard key={a.id} album={a} />)}
          </Row>
        )}
        {d.kind === 'artist' && d.data.related.length > 0 && (
          <Row title="Fans also like" variant="circle" id="m-related">
            {d.data.related.map(a => <ArtistCard key={a.id} artist={a} />)}
          </Row>
        )}
      </div>
    </main>
  )
}
