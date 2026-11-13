import { useEffect, useRef, useState } from 'react'
import {
  Cast, ChevronDown, Clapperboard, Disc3, ListMusic, MicVocal, Pause, Play, Radio, SkipBack, SkipForward, Tv, X,
} from 'lucide-react'
import type { LyricLine, MusicCastMode, MusicLyrics, MusicTrack } from '../../../shared/music.ts'
import { api, type CastDevice } from '../api.ts'
import { navigate, useLocation } from '../router.ts'
import { musicApi } from './api.ts'
import {
  castMode, castTo, castVolume, closeMusic, closePlayer, jump, liveTime, next, openPlayer, pause, prev, removeAt, seek, setView, stopCasting,
  toggle, usePlayer,
  CROSSFADE_CHOICES, setCrossfade, useCrossfade,
} from './player.ts'
import { Art, Bars, coverOf, duration, LikeButton, SongMenu, whyOf } from './ui.tsx'

// The mini player along the bottom of every page, and the full-screen player it opens: the cover large over
// its own colours, the words in time with the song, what's next, and sending it all to a TV.

/** The song's position, redrawn every frame while it plays (the element and the TV report less often). */
function useClock (): number {
  const p = usePlayer()
  const [t, setT] = useState(liveTime)
  useEffect(() => {
    if (!p.playing) { setT(liveTime()); return }
    let raf = 0
    const tick = () => { setT(liveTime()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [p.playing, p.time, p.index])
  return t
}

function Scrubber ({ big = false }: { big?: boolean }) {
  const { duration: d } = usePlayer()
  const t = useClock()
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? t
  const pct = d > 0 ? Math.min(100, (shown / d) * 100) : 0
  return (
    <div className={`np-scrub${big ? ' big' : ''}`}>
      <input
        type="range" min={0} max={Math.max(1, d)} step={0.5} value={shown}
        style={{ '--p': `${pct}%` } as React.CSSProperties}
        aria-label="Position in song" aria-valuetext={`${duration(shown)} of ${duration(d)}`}
        onChange={e => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag !== null) { seek(drag); setDrag(null) } }}
        onKeyUp={() => { if (drag !== null) { seek(drag); setDrag(null) } }}
      />
      {big && <div className="np-times"><span>{duration(shown) || '0:00'}</span><span>{d > 0 ? `-${duration(Math.max(0, d - shown))}` : ''}</span></div>}
    </div>
  )
}

function PlayButton ({ className }: { className: string }) {
  const { playing, buffering, cast } = usePlayer()
  const busy = buffering && !cast?.active ? true : buffering && cast?.state === 'loading'
  return (
    <button type="button" className={`${className}${busy ? ' busy' : ''}`} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
      {playing ? <Pause aria-hidden fill="currentColor" /> : <Play aria-hidden fill="currentColor" />}
    </button>
  )
}

// ---- Lyrics ----

const lyricsCache = new Map<string, Promise<MusicLyrics>>()
function useLyrics (t: MusicTrack | undefined): MusicLyrics | 'loading' | null {
  const [l, setL] = useState<MusicLyrics | 'loading' | null>('loading')
  useEffect(() => {
    if (!t) { setL(null); return }
    let p = lyricsCache.get(t.id)
    if (!p) {
      p = musicApi.lyrics(t.id)
      p.catch(() => lyricsCache.delete(t.id))
      lyricsCache.set(t.id, p)
    }
    let live = true
    setL('loading')
    p.then(x => { if (live) setL(x) }, () => { if (live) setL(null) })
    return () => { live = false }
  }, [t?.id])
  return l
}

/** The line being sung: the last one that has started (a quarter second early, as the eye leads the ear). */
export function activeLine (lines: LyricLine[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= t + 0.25) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

function Lyrics ({ track }: { track: MusicTrack | undefined }) {
  const lyrics = useLyrics(track)
  const t = useClock()
  const box = useRef<HTMLDivElement>(null)
  const touched = useRef(0)
  const synced = lyrics && lyrics !== 'loading' ? lyrics.synced : null
  const at = synced ? activeLine(synced, t) : -1

  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${Math.max(0, at)}"]`)
    if (!el || !box.current || Date.now() - touched.current < 4000) return
    const top = el.offsetTop - box.current.clientHeight * 0.38
    box.current.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [at, track?.id])

  if (lyrics === 'loading') return <div className="np-lyrics-empty"><span className="np-lyrics-wait" aria-label="Loading lyrics" /></div>
  if (!lyrics || (!lyrics.synced && !lyrics.plain)) {
    return <div className="np-lyrics-empty"><p>{lyrics?.instrumental ? 'This one’s instrumental.' : 'No lyrics for this song yet.'}</p></div>
  }
  if (!synced) {
    return (
      <div className="np-lyrics plain" ref={box}>
        {lyrics.plain!.split(/\n/).map((line, i) => <p key={i} className="np-line">{line || ' '}</p>)}
        <p className="np-lyrics-note">These words aren’t timed to the song.</p>
      </div>
    )
  }
  return (
    <div className="np-lyrics" ref={box} onWheel={() => { touched.current = Date.now() }} onTouchMove={() => { touched.current = Date.now() }} aria-live="off">
      {synced.map((l, i) => (
        <button
          type="button" key={i} data-i={i}
          className={`np-line${i === at ? ' now' : i < at ? ' past' : ''}${l.text ? '' : ' gap'}`}
          onClick={() => { touched.current = 0; seek(l.t) }}
          aria-current={i === at ? 'true' : undefined}
        >
          {l.text || '♪'}
        </button>
      ))}
    </div>
  )
}

// ---- Queue ----

function Queue () {
  const { queue, index, from, playing } = usePlayer()
  const nowRef = useRef<HTMLLIElement>(null)
  useEffect(() => { nowRef.current?.scrollIntoView({ block: 'start' }) }, [])
  return (
    <div className="np-queue">
      <p className="np-queue-from">Playing from <strong>{from || 'your queue'}</strong></p>
      <ol>
        {queue.map((t, i) => (
          <li key={`${t.id}-${i}`} ref={i === index ? nowRef : undefined} className={`np-q${i === index ? ' now' : i < index ? ' past' : ''}`}>
            <button type="button" className="np-q-main" onClick={() => jump(i)}>
              <span className="np-q-art"><Art src={coverOf(t)} size={120} />{i === index && <span className="m-song-playing"><Bars live={playing} /></span>}</span>
              <span className="m-song-text">
                <span className="m-song-title">{t.title}</span>
                <span className="m-song-sub">{t.credit ?? t.artist.name}{i > index && whyOf(t) && <span className="m-song-why"> · {whyOf(t)}</span>}</span>
              </span>
            </button>
            {i > index && <button type="button" className="m-icon" aria-label={`Remove ${t.title} from the queue`} onClick={() => removeAt(i)}><X aria-hidden /></button>}
          </li>
        ))}
      </ol>
      <p className="np-queue-note"><Radio aria-hidden /> When this runs out, more songs like these follow.</p>
      <Crossfade />
    </div>
  )
}

/** How much the end of one song overlaps the next (album tracks always run on as recorded). */
function Crossfade () {
  const fade = useCrossfade()
  if (fade < 0) return null // this browser can't fade (iOS)
  return (
    <div className="np-fade" role="radiogroup" aria-label="Crossfade between songs">
      <span className="np-fade-label">Crossfade</span>
      {CROSSFADE_CHOICES.map(s => (
        <button key={s} type="button" role="radio" aria-checked={fade === s} className={`np-fade-option${fade === s ? ' on' : ''}`} onClick={() => setCrossfade(s)}>
          {s ? `${s} s` : 'Off'}
        </button>
      ))}
    </div>
  )
}

// ---- Cast ----

const MODES: Array<{ mode: MusicCastMode; label: string; icon: React.ReactNode; note: string }> = [
  { mode: 'audio', label: 'Song', icon: <Disc3 aria-hidden />, note: 'The song with its cover' },
  { mode: 'lyrics', label: 'Lyrics', icon: <MicVocal aria-hidden />, note: 'Words in time, over moving artwork' },
  { mode: 'video', label: 'Music video', icon: <Clapperboard aria-hidden />, note: 'Takes a few seconds to start' },
]

function CastSheet ({ onClose }: { onClose: () => void }) {
  const { cast } = usePlayer()
  const [devices, setDevices] = useState<CastDevice[] | null>(null)
  const [scanning, setScanning] = useState(true)
  const [mode, setMode] = useState<MusicCastMode>(cast?.mode ?? 'lyrics')
  const [modes, setModes] = useState<MusicCastMode[]>(cast?.modes ?? ['audio', 'lyrics', 'video'])
  useEffect(() => {
    api.castDevices().then(r => setDevices(d => d ?? r.devices)).catch(() => {})
    api.castDevices(true).then(r => setDevices(r.devices)).catch(() => setDevices(d => d ?? [])).finally(() => setScanning(false))
    musicApi.cast().then(c => { if (c.modes) { setModes(c.modes); if (!c.modes.includes(mode)) setMode('audio') } }).catch(() => {})
  }, [])
  const casting = Boolean(cast?.active)
  const pick = (m: MusicCastMode) => { setMode(m); if (casting) castMode(m) }
  return (
    <div className="np-sheet" role="dialog" aria-label="Play on a TV">
      <div className="np-sheet-head">
        <h3>{casting ? `Playing on ${cast!.device?.name}` : 'Play on a TV'}</h3>
        <button type="button" className="m-icon" aria-label="Close" onClick={onClose}><X aria-hidden /></button>
      </div>
      <p className="np-sheet-label">Show on the TV</p>
      <div className="np-modes" role="radiogroup" aria-label="What the TV shows">
        {MODES.filter(m => modes.includes(m.mode)).map(m => (
          <button key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} className={`np-mode${mode === m.mode ? ' on' : ''}`} onClick={() => pick(m.mode)}>
            {m.icon}<span><strong>{m.label}</strong><small>{m.note}</small></span>
          </button>
        ))}
      </div>
      {casting
        ? (
          <>
            {typeof cast!.volume === 'number' && (
              <label className="np-volume">
                <span>TV volume</span>
                <input type="range" min={0} max={1} step={0.05} defaultValue={cast!.volume} onChange={e => castVolume(Number(e.target.value))} />
              </label>
            )}
            <button type="button" className="button secondary np-stop" onClick={() => { void stopCasting(); onClose() }}><X aria-hidden />Stop playing on the TV</button>
          </>
          )
        : (
          <>
            <p className="np-sheet-label">TVs on your Wi-Fi{scanning && <span className="np-scan" aria-label="Looking for TVs" />}</p>
            <div className="np-devices">
              {devices?.map(d => (
                <button key={d.id} type="button" className="np-device" onClick={() => { void castTo(d.id, mode); onClose() }}>
                  <Tv aria-hidden /><span><strong>{d.name}</strong><small>{d.model}</small></span>
                </button>
              ))}
              {devices && !devices.length && !scanning && <p className="np-sheet-note">No TVs found. The TV needs Chromecast (built in or plugged in) and the same Wi-Fi as this computer.</p>}
            </div>
          </>
          )}
    </div>
  )
}

// ---- The full-screen player ----

export function NowPlaying () {
  const p = usePlayer()
  const t = p.queue[p.index]
  const [castOpen, setCastOpen] = useState(false)
  const cover = coverOf(t)

  useEffect(() => {
    if (!p.open) return
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Escape') { if (castOpen) setCastOpen(false); else closePlayer() }
      if (e.key === ' ') { e.preventDefault(); toggle() }
    }
    document.addEventListener('keydown', key)
    document.documentElement.classList.add('np-open')
    return () => { document.removeEventListener('keydown', key); document.documentElement.classList.remove('np-open') }
  }, [p.open, castOpen])

  if (!p.open || !t) return null
  const side = p.view === 'queue' ? 'queue' : 'lyrics'
  const toggleView = (v: 'lyrics' | 'queue') => setView(p.view === v ? 'art' : v)
  return (
    <div className={`np view-${p.view}`} role="dialog" aria-modal="true" aria-label={`Now playing: ${t.title}`}>
      <div className="np-bg" aria-hidden>
        {cover && <><Art src={cover} size={120} className="a" /><Art src={cover} size={120} className="b" /></>}
      </div>
      <header className="np-top">
        <button type="button" className="m-icon big" aria-label="Close player" onClick={closePlayer}><ChevronDown aria-hidden /></button>
        <p className="np-from"><span>{p.cast?.active ? `Playing on ${p.cast.device?.name}` : 'Playing from'}</span><strong>{p.from || 'Your queue'}</strong></p>
        <SongMenu track={t} />
      </header>

      <div className="np-body">
        <section className="np-stage">
          <div className="np-cover"><Art src={cover} size={640} low={120} alt={t.album?.title ?? ''} /></div>
          <div className="np-meta">
            <div className="np-meta-text">
              <h2 className="np-title">{t.title}</h2>
              <a className="np-artist" href={`/music/artist/${t.artist.id}`} onClick={e => { e.preventDefault(); closePlayer(); setTimeout(() => navigate(`/music/artist/${t.artist.id}`), 0) }}>{t.credit ?? t.artist.name}</a>
            </div>
            <LikeButton track={t} className="m-icon big" />
          </div>
          <Scrubber big />
          <div className="np-buttons">
            <button type="button" className="m-icon huge" onClick={prev} aria-label="Previous"><SkipBack aria-hidden fill="currentColor" /></button>
            <PlayButton className="np-play" />
            <button type="button" className="m-icon huge" onClick={next} aria-label="Next"><SkipForward aria-hidden fill="currentColor" /></button>
          </div>
          <div className="np-tools">
            <button type="button" className={`m-icon${p.view === 'lyrics' ? ' on' : ''}`} aria-pressed={p.view === 'lyrics'} onClick={() => toggleView('lyrics')} aria-label="Lyrics"><MicVocal aria-hidden /></button>
            <button type="button" className={`m-icon${p.cast?.active ? ' on' : ''}`} onClick={() => setCastOpen(true)} aria-label={p.cast?.active ? `Playing on ${p.cast.device?.name}` : 'Play on a TV'}><Cast aria-hidden /></button>
            <button type="button" className={`m-icon${p.view === 'queue' ? ' on' : ''}`} aria-pressed={p.view === 'queue'} onClick={() => toggleView('queue')} aria-label="Up next"><ListMusic aria-hidden /></button>
          </div>
        </section>
        <section className={`np-side side-${side}`} aria-label={side === 'queue' ? 'Up next' : 'Lyrics'}>
          {side === 'queue' ? <Queue /> : <Lyrics track={t} />}
        </section>
      </div>
      {p.cast?.active && p.cast.error && <p className="np-cast-note">{p.cast.error}</p>}
      {castOpen && <CastSheet onClose={() => setCastOpen(false)} />}
    </div>
  )
}

// ---- The bar along the bottom ----

export function MiniPlayer () {
  const p = usePlayer()
  const { path } = useLocation()
  const t = p.queue[p.index]
  const onWatch = path === '/watch'
  const visible = Boolean(t) && !onWatch && !p.open

  // A film is playing: the music stops (it would play over it).
  useEffect(() => { if (onWatch) pause() }, [onWatch])
  useEffect(() => {
    document.documentElement.classList.toggle('has-mini', visible)
    return () => document.documentElement.classList.remove('has-mini')
  }, [visible])

  if (!visible || !t) return null
  const pct = p.duration > 0 ? Math.min(100, (p.time / p.duration) * 100) : 0
  return (
    <div className="mini" role="region" aria-label="Music player">
      <div className="mini-progress" style={{ '--p': `${pct}%` } as React.CSSProperties} aria-hidden />
      <button type="button" className="mini-open" onClick={() => openPlayer()} aria-label={`Open player: ${t.title} by ${t.credit ?? t.artist.name}`}>
        <Art src={coverOf(t)} size={120} />
        <span className="m-song-text">
          <span className="m-song-title">{t.title}</span>
          <span className="m-song-sub">{p.cast?.active ? `On ${p.cast.device?.name}` : t.credit ?? t.artist.name}</span>
        </span>
      </button>
      <div className="mini-controls">
        <button type="button" className="m-icon wide-only" onClick={prev} aria-label="Previous"><SkipBack aria-hidden fill="currentColor" /></button>
        <PlayButton className="mini-play" />
        <button type="button" className="m-icon" onClick={next} aria-label="Next"><SkipForward aria-hidden fill="currentColor" /></button>
      </div>
      <div className="mini-tools wide-only">
        <LikeButton track={t} />
        <button type="button" className="m-icon" onClick={() => openPlayer('lyrics')} aria-label="Lyrics"><MicVocal aria-hidden /></button>
        <button type="button" className="m-icon" onClick={() => openPlayer('queue')} aria-label="Up next"><ListMusic aria-hidden /></button>
        <button type="button" className={`m-icon${p.cast?.active ? ' on' : ''}`} onClick={() => openPlayer()} aria-label="Play on a TV"><Cast aria-hidden /></button>
      </div>
      <button type="button" className="m-icon mini-close" onClick={closeMusic} aria-label="Close music" title="Close music"><X aria-hidden /></button>
    </div>
  )
}
