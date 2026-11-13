import { useEffect, useRef, useState } from 'react'
import { ArrowRight, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import type { MusicArtist, MusicHome, MusicMixCard, MusicSearchResponse } from '../../../shared/music.ts'
import { BrowseTabs } from '../components/BrowseTabs.tsx'
import { ProfileMenu } from '../components/ProfileMenu.tsx'
import { Row } from '../components/Row.tsx'
import { Wordmark } from '../components/Wordmark.tsx'
import { useDocumentTitle, useScrolled } from '../hooks.ts'
import { musicApi } from '../music/api.ts'
import { joinCast, playList, playRadio } from '../music/player.ts'
import { AlbumCard, ArtistCard, MixCard, SongCard, SongList } from '../music/ui.tsx'
import { navigate, onLinkClick, replaceUrl } from '../router.ts'
import { toast } from '../toast.ts'

// Music: mixes made for this profile, a box to ask for anything, and search. Songs play on this computer or a
// phone at home (they come from the computer), and on a TV.

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string }

const MOODS = ['Feel-good', 'Focus', 'Workout', 'Chill', 'Romantic', 'Sad songs', 'Party', 'Road trip', 'Throwback', 'Something new']

const FINE_POINTER = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches

/** What follows a mix when it runs out: more of the listener's taste for their own mixes, else a radio. */
const thenFor = (kind: MusicMixCard['kind']) => (kind === 'daily' || kind === 'discover' || kind === 'repeat' || kind === 'liked' ? {} : undefined)

export async function playMix (mix: MusicMixCard) {
  try {
    const m = await musicApi.mix(mix.id)
    playList(m.tracks, 0, m.title, thenFor(m.kind))
  } catch (err) {
    toast((err as Error).message)
  }
}

export function Music ({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery)
  const scrolled = useScrolled()
  const input = useRef<HTMLInputElement>(null)
  const q = query.trim()
  useDocumentTitle(q ? `“${q}” in Music` : 'Music')
  useEffect(() => { joinCast() }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      const url = q ? `/music?q=${encodeURIComponent(q)}` : '/music'
      if (url !== location.pathname + location.search) replaceUrl(url)
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  return (
    <main className={`home music${q ? ' is-searching' : ''}`}>
      <h1 className="sr-only">Music</h1>
      <header className={`masthead${scrolled || q ? ' is-solid' : ''}`}>
        <div className="masthead-start">
          <Wordmark />
          <BrowseTabs current="/music" />
        </div>
        <div className="masthead-end">
          <form className="search" role="search" onSubmit={e => e.preventDefault()}>
            <Search className="search-icon" aria-hidden />
            <input
              ref={input}
              autoFocus={FINE_POINTER && Boolean(initialQuery)}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search songs and artists"
              aria-label="Search songs and artists"
              enterKeyHint="search"
              spellCheck={false}
            />
            {query && (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery(''); input.current?.focus() }}>
                <X aria-hidden />
              </button>
            )}
          </form>
          <ProfileMenu />
        </div>
      </header>
      <div className="masthead-spacer" />
      {q.length >= 2 ? <MusicSearch q={q} /> : <MusicFeed />}
    </main>
  )
}

// ---- Search ----

function MusicSearch ({ q }: { q: string }) {
  const [res, setRes] = useState<Load<MusicSearchResponse>>({ state: 'loading' })
  useEffect(() => {
    const ctl = new AbortController()
    setRes({ state: 'loading' })
    const t = setTimeout(() => {
      musicApi.search(q, ctl.signal).then(data => setRes({ state: 'ok', data })).catch(err => {
        if ((err as Error).name !== 'AbortError') setRes({ state: 'error', message: (err as Error).message })
      })
    }, 350)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q])

  if (res.state === 'loading') return <section className="m-page"><SongsSkeleton /></section>
  if (res.state === 'error') return <section className="m-page"><p className="notice">Search failed: {res.message}</p></section>
  const { tracks, artists, albums } = res.data
  if (!tracks.length && !artists.length) {
    return (
      <section className="m-page">
        <div className="empty">
          <p className="empty-title">Nothing found for “{q}”</p>
          <p className="notice">Try the song’s name and the singer, or fewer words.</p>
        </div>
      </section>
    )
  }
  return (
    <section className="m-page m-results" aria-live="polite">
      {artists.length > 0 && (
        <Row title="Artists" variant="circle" id="m-res-artists">
          {artists.map(a => <ArtistCard key={a.id} artist={a} />)}
        </Row>
      )}
      {tracks.length > 0 && (
        <section className="m-section">
          <h2 className="row-title">Songs</h2>
          <SongList tracks={tracks.slice(0, 20)} from={`Search: ${q}`} />
        </section>
      )}
      {albums.length > 0 && (
        <Row title="Albums" variant="square" id="m-res-albums">
          {albums.map(a => <AlbumCard key={a.id} album={a} />)}
        </Row>
      )}
    </section>
  )
}

function SongsSkeleton () {
  return (
    <ol className="m-songs" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="m-song"><span className="m-song-main"><span className="m-song-art skeleton" /><span className="m-song-text"><span className="skeleton-line" /><span className="skeleton-line short" /></span></span></li>
      ))}
    </ol>
  )
}

// ---- Home ----

function MusicFeed () {
  const [home, setHome] = useState<Load<MusicHome>>({ state: 'loading' })
  const load = (refresh = false) => {
    if (refresh) setHome(h => (h.state === 'ok' ? h : { state: 'loading' }))
    return musicApi.home(refresh).then(data => setHome({ state: 'ok', data })).catch(err => setHome({ state: 'error', message: (err as Error).message }))
  }
  useEffect(() => { void load() }, [])

  if (home.state === 'loading') return <FeedSkeleton />
  if (home.state === 'error') return <section className="m-page"><p className="notice">Music didn’t load: {home.message}</p></section>
  const h = home.data
  const liked: MusicMixCard | null = h.likedCount > 0
    ? { id: 'liked', kind: 'liked', title: 'Liked songs', subtitle: `${h.likedCount} song${h.likedCount === 1 ? '' : 's'}`, covers: h.liked.map(t => t.album?.cover ?? t.artist.picture).filter((c): c is string => Boolean(c)).slice(0, 4), count: h.likedCount, at: 0 }
    : null

  return (
    <div className="m-page m-home">
      {!h.setup.ready && <SetupBanner setup={h.setup} onReady={() => void load()} />}
      <AskBox ai={h.ai} />
      {h.needsSeeds && <PickArtists onDone={() => void load(true)} />}
      {(h.mixes.length > 0 || liked) && (
        <Row
          title="Made for you" variant="square" id="m-mixes"
          caption="From what you play, like and skip"
          aside={<button type="button" className="row-link" onClick={() => { void load(true).then(() => toast('Your mixes are fresh.')) }}><RefreshCw aria-hidden />Refresh</button>}
        >
          {liked && <MixCard mix={liked} onPlay={() => void playMix(liked)} />}
          {h.mixes.map(m => <MixCard key={m.id} mix={m} onPlay={() => void playMix(m)} />)}
        </Row>
      )}
      {h.recent.length > 0 && (
        <Row title="Jump back in" variant="square" id="m-recent">
          {h.recent.map((t, i) => <SongCard key={t.id} track={t} onPlay={() => playList(h.recent, i, 'Recently played')} />)}
        </Row>
      )}
      {h.artists.length > 0 && (
        <Row title="Your artists" variant="circle" id="m-artists">
          {h.artists.map(a => <ArtistCard key={a.id} artist={a} />)}
        </Row>
      )}
      {h.trending.length > 0 && (
        <Row title="Popular now" variant="square" id="m-trending" caption="Most played this week">
          {h.trending.map((t, i) => <SongCard key={t.id} track={t} onPlay={() => playList(h.trending, i, 'Popular now')} />)}
        </Row>
      )}
    </div>
  )
}

function FeedSkeleton () {
  return (
    <div className="m-page m-home" aria-busy="true">
      <div className="m-ask skeleton-block skeleton" />
      {[0, 1].map(r => (
        <section key={r} className="row row-square">
          <header className="row-head"><span className="skeleton-line short" /></header>
          <div className="row-scroller">{Array.from({ length: 6 }, (_, i) => <div key={i} className="m-card"><span className="m-card-art skeleton" /><span className="skeleton-line" /></div>)}</div>
        </section>
      ))}
    </div>
  )
}

/**
 * "Set up music": downloads yt-dlp on the computer. That can take minutes on a slow line, so the server does
 * it in the background and this follows along every second, with a progress bar, until it's ready or fails.
 */
function SetupBanner ({ setup: first, onReady }: { setup: MusicHome['setup']; onReady: () => void }) {
  const [setup, setSetup] = useState(first)
  const [pressing, setPressing] = useState(false)
  const ready = useRef(onReady)
  ready.current = onReady
  const installing = setup.helper === 'installing'

  useEffect(() => {
    if (!installing) return
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const s = await musicApi.setupStatus()
        if (stop) return
        if (s.ready) { toast('Music is ready.'); ready.current(); return }
        setSetup(s)
        if (s.helper !== 'installing') return
      } catch { /* the computer is busy or restarting: keep asking */ }
      if (!stop) timer = setTimeout(() => void tick(), 1000)
    }
    timer = setTimeout(() => void tick(), 1000)
    return () => { stop = true; clearTimeout(timer) }
  }, [installing])

  const run = async () => {
    setPressing(true)
    try {
      const s = await musicApi.setup()
      if (s.ready) { toast('Music is ready.'); ready.current(); return }
      setSetup(s)
    } catch (err) {
      setSetup(s => ({ ...s, helper: 'error', message: (err as Error).message }))
    } finally {
      setPressing(false)
    }
  }

  const pct = setup.progress !== undefined ? Math.round(setup.progress * 100) : undefined
  return (
    <section className="m-setup" aria-labelledby="m-setup-title">
      <h2 id="m-setup-title" className="m-setup-title">{installing ? 'Setting up music' : 'One step before the music starts'}</h2>
      {installing
        ? (
          <>
            <div className="m-setup-bar" role="progressbar" aria-label="Setting up music" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span style={{ width: `${pct ?? 4}%` }} className={pct === undefined ? 'waiting' : undefined} />
            </div>
            <p className="notice">{setup.message ?? 'Starting the download.'} It carries on if you leave this page.</p>
          </>
          )
        : setup.canInstall
          ? (
            <>
              <p className="notice">nexttupp gets songs with a small free helper, yt-dlp (about 40 MB). It downloads once, from its official page, and stays on this computer.</p>
              {setup.helper === 'error' && setup.message && <p className="m-setup-problem">{setup.message}</p>}
              <button type="button" className="button primary" onClick={() => void run()} disabled={pressing}>
                {pressing ? <><span className="spinner" aria-hidden />Starting…</> : setup.helper === 'error' ? 'Try again' : 'Set up music'}
              </button>
            </>
            )
          : <p className="notice">Open nexttupp on your computer, choose <strong>Music</strong>, and press <strong>Set up music</strong>. Then songs play here too.</p>}
    </section>
  )
}

function AskBox ({ ai }: { ai: MusicHome['ai'] }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const ask = async (words: string) => {
    const w = words.trim()
    if (busy) return
    setBusy(w || 'mix')
    try {
      if (ai.hint) {
        const mix = await musicApi.aiMix(w || undefined)
        playList(mix.tracks, 0, mix.title, {})
        navigate(`/music/mix/${mix.id}`)
      } else if (w) {
        await playRadio({ mood: w }, w)
      }
    } catch (err) {
      toast((err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="m-ask" aria-labelledby="m-ask-title">
      <h2 id="m-ask-title" className="m-ask-title">What do you want to hear?</h2>
      <form className="m-ask-form" onSubmit={e => { e.preventDefault(); void ask(text) }}>
        <input
          value={text} onChange={e => setText(e.target.value)} maxLength={300}
          placeholder={ai.hint ? 'Late-night drive, 90s Bollywood, songs like Kesariya…' : 'A mood or a moment: rainy evening, workout…'}
          aria-label="Describe the music you want" enterKeyHint="go"
        />
        <button type="submit" className="m-ask-go" disabled={Boolean(busy) || (!text.trim() && !ai.hint)} aria-label="Make the mix">
          {busy ? <span className="spinner" aria-hidden /> : <ArrowRight aria-hidden />}
        </button>
      </form>
      <div className="m-moods" role="list">
        {ai.hint && (
          <button type="button" role="listitem" className="chip m-surprise" disabled={Boolean(busy)} onClick={() => void ask('')}>
            <Sparkles aria-hidden />Surprise me
          </button>
        )}
        {MOODS.map(m => <button key={m} type="button" role="listitem" className="chip" disabled={Boolean(busy)} onClick={() => void ask(m)}>{m}</button>)}
      </div>
      <p className="m-ask-note">
        {busy
          ? (ai.hint ? 'Making your mix. AI takes a few seconds…' : 'Finding songs…')
          : ai.hint
            ? <>Mixes are made by AI from your taste ({ai.hint}).</>
            : ai.available
              ? 'AI is connected but has no model yet. Mixes come from playlists, picked for you.'
              : <>Mixes come from playlists, picked for your taste. <a href="/ai" onClick={onLinkClick}>Connect AI</a> for mixes made just for you.</>}
      </p>
    </section>
  )
}

function PickArtists ({ onDone }: { onDone: () => void }) {
  const [artists, setArtists] = useState<MusicArtist[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [find, setFind] = useState('')
  const [found, setFound] = useState<MusicArtist[]>([])
  useEffect(() => { musicApi.starters().then(r => setArtists(r.artists)).catch(() => setArtists([])) }, [])
  useEffect(() => {
    const w = find.trim()
    if (w.length < 2) { setFound([]); return }
    const t = setTimeout(() => { musicApi.search(w).then(r => setFound(r.artists)).catch(() => {}) }, 350)
    return () => clearTimeout(t)
  }, [find])
  const toggle = (a: MusicArtist) => {
    const on = !picked.has(a.id)
    const next = new Set(picked)
    if (on) next.add(a.id); else next.delete(a.id)
    setPicked(next)
    musicApi.rate('artist', a.id, on ? 1 : 0).catch(err => toast((err as Error).message))
  }
  const list = [...found, ...(artists ?? []).filter(a => !found.some(f => f.id === a.id))]
  return (
    <section className="m-pick" aria-labelledby="m-pick-title">
      <div className="m-pick-head">
        <div>
          <h2 id="m-pick-title" className="row-title">Pick a few artists you love</h2>
          <p className="row-caption">Your mixes start from them. Three or more works best.</p>
        </div>
        <button type="button" className="button primary" disabled={!picked.size} onClick={onDone}>
          {picked.size ? `Make my mixes (${picked.size})` : 'Make my mixes'}
        </button>
      </div>
      <div className="search m-pick-find">
        <Search className="search-icon" aria-hidden />
        <input value={find} onChange={e => setFind(e.target.value)} placeholder="Find an artist" aria-label="Find an artist" spellCheck={false} />
      </div>
      <div className="m-pick-grid">
        {artists === null && Array.from({ length: 12 }, (_, i) => <div key={i} className="m-card m-card-artist"><span className="m-card-art skeleton round" /></div>)}
        {list.map(a => <ArtistCard key={a.id} artist={a} pressed={picked.has(a.id)} onClick={() => toggle(a)} />)}
      </div>
    </section>
  )
}
