import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, AudioLines, Captions, Check, CircleArrowDown, Download, Info, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX, X,
} from 'lucide-react'
import type { MediaType, ProbeResponse, ProgressRequest, WatchProgress } from '../../../shared/types.ts'
import { api, capsParam, getActiveProfile, type Cue, type Stats, type SubtitleOption } from '../api.ts'
import { detectCaps } from '../caps.ts'
import { bytes, clock, languageName, speed } from '../format.ts'
import { useDocumentTitle } from '../hooks.ts'
import { navigate } from '../router.ts'
import { readKey, readSessionKey, writeKey } from '../storage.ts'
import { TitleArt } from '../components/TitleArt.tsx'

type Phase = 'connecting' | 'probing' | 'ready' | 'error'

/** `p` is the profile that saved it; positions saved before profiles existed have none. */
interface Progress { t: number; d: number; at: number; p?: string }
// Saved as `nexttupp:progress:<streamId>`; positions saved under the old `nextup:` prefix are still read.
const progressKey = (streamId: string) => `progress:${streamId}`
function loadProgress (streamId: string): Progress | null {
  try { return JSON.parse(readKey(progressKey(streamId)) ?? 'null') } catch { return null }
}
function saveProgress (streamId: string, p: Progress) {
  writeKey(progressKey(streamId), JSON.stringify(p))
}

const IMDB_ID = /^tt\d+$/
const STREAM_ID = /^tt\d+(:\d+:\d+)?$/
/** Progress reports while playing. */
const REPORT_EVERY_MS = 10_000

/**
 * The profile's saved position for this stream, from the server (so it follows the profile across devices).
 * `null`: the server has none. `undefined`: the server couldn't be asked.
 */
function serverPosition (type: MediaType, imdbId: string, streamId: string): Promise<WatchProgress | null | undefined> {
  if (!IMDB_ID.test(imdbId)) return Promise.resolve(undefined)
  return api.titleState(type, imdbId)
    .then(s => (s.episodes ?? (s.progress ? [s.progress] : [])).find(p => p.streamId === streamId) ?? null)
    .catch(() => undefined)
}

export function Watch ({ query }: { query: URLSearchParams }) {
  const infoHash = query.get('ih') ?? ''
  const fileIdx = query.get('f') !== null ? Number(query.get('f')) : undefined
  const fileName = query.get('fn') ?? undefined
  const type = (query.get('type') ?? 'movie') as MediaType
  const imdbId = query.get('id') ?? ''
  const streamId = query.get('s') ?? imdbId
  const name = query.get('n') ?? ''
  const caps = useMemo(detectCaps, [])

  const video = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [info, setInfo] = useState<ProbeResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [phaseStarted, setPhaseStarted] = useState(Date.now())
  // "Download to watch later" for a slow swarm, before the player has a session to pin.
  const [later, setLater] = useState<'idle' | 'saving' | 'saved'>('idle')

  // Playback timeline. A converted stream's <video> clock restarts at 0, so `origin` maps it to film
  // time: exactly the requested time when transcoding, or the keyframe before it when copying video
  // (the server looks that up; see /api/sessions/:id/stream-start).
  const streamStart = useRef(0)
  const origin = useRef(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(true)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [chrome, setChrome] = useState(true)
  const [panel, setPanel] = useState<'none' | 'audio' | 'subs' | 'info'>('none')
  const [audioTrack, setAudioTrack] = useState<number | undefined>(undefined)
  const [resumedFrom, setResumedFrom] = useState<number | null>(null)

  const [subs, setSubs] = useState<SubtitleOption[]>([])
  const [subChoice, setSubChoice] = useState<SubtitleOption | null>(null)
  const [cues, setCues] = useState<Cue[]>([])
  const [subOffset, setSubOffset] = useState(0)

  const sessionId = stats?.id
  const duration = info?.probe.durationSec ?? 0
  const mode = info?.plan.mode

  // Where this profile left off, asked for straight away so it's known by the time the file is.
  const savedOnServer = useRef<Promise<WatchProgress | null | undefined> | null>(null)
  savedOnServer.current ??= serverPosition(type, imdbId, streamId)

  // 1. Open the torrent and pick the file.
  useEffect(() => {
    let live = true
    setPhase('connecting'); setPhaseStarted(Date.now()); setError(null)
    let trackers: string[] = []
    try { trackers = JSON.parse(readSessionKey(`trackers:${infoHash}`) ?? '[]') } catch { /* none */ }
    api.open({ infoHash, fileIdx, fileName, trackers, title: name })
      .then(s => { if (live) { setStats(s); setPhase('probing'); setPhaseStarted(Date.now()) } })
      .catch(err => { if (live) { setError(err.message); setPhase('error') } })
    return () => { live = false }
  }, [infoHash, fileIdx, fileName, name, attempt])

  // While waiting on the swarm nothing else re-renders; tick so the elapsed time (and the slow-source offer) show.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (phase !== 'connecting' && phase !== 'probing') return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [phase])

  // 2. Live swarm stats.
  useEffect(() => {
    if (!sessionId) return
    const id = setInterval(() => {
      if (document.hidden) return
      api.stats(sessionId).then(setStats).catch(() => {})
    }, 1000)
    return () => clearInterval(id)
  }, [sessionId])

  // 3. Inspect the file and decide direct play / remux / transcode.
  useEffect(() => {
    if (!sessionId || phase !== 'probing') return
    let live = true
    api.probe(sessionId, caps)
      .then(r => { if (live) { setInfo(r); setAudioTrack(r.plan.audioTrack); setPhase('ready') } })
      .catch(err => { if (live) { setError(err.message); setPhase('error') } })
    return () => { live = false }
  }, [sessionId, phase, caps])

  const streamUrl = useCallback((t: number, audio: number | undefined) =>
    `/stream/${sessionId}/play.mp4?t=${t.toFixed(2)}&caps=${capsParam(caps)}${audio !== undefined ? `&audio=${audio}` : ''}`, [sessionId, caps])

  const usesConversion = (audio: number | undefined) => mode !== 'direct' || (audio !== undefined && audio !== 0 && info!.probe.audio.length > 1)

  /** Starts (or restarts) the converted stream at film time t. */
  const startStream = useCallback((t: number, audio: number | undefined) => {
    const v = video.current
    if (!v || !sessionId) return
    streamStart.current = t
    origin.current = t
    if (info?.plan.copyVideo && t > 0) {
      api.streamStart(sessionId, t).then(r => {
        if (streamStart.current === t) { origin.current = r.start; setTime(r.start + v.currentTime) }
      }).catch(() => {})
    }
    setBuffering(true)
    v.src = streamUrl(t, audio)
    v.play().catch(() => {})
  }, [sessionId, streamUrl, info])

  // 4. Attach the source once we know the plan, resuming where the viewer left off: the profile's position on
  //    the server first; this browser's own record only when the server has none (and it was this profile's)
  //    or can't be reached.
  useEffect(() => {
    const v = video.current
    if (phase !== 'ready' || !info || !v || !sessionId) return
    let live = true
    const wait = new Promise<undefined>(resolve => setTimeout(resolve, 1500, undefined))
    Promise.race([savedOnServer.current!, wait]).then(server => {
      if (!live) return
      const local = loadProgress(streamId)
      const mine = local && (local.p === undefined || local.p === getActiveProfile())
      const at = server ? (server.completed ? 0 : server.position) : server === null ? (mine ? local!.t : 0) : local?.t ?? 0
      const resumeAt = at > 30 && at < info.probe.durationSec - 90 ? at : 0
      if (resumeAt) setResumedFrom(resumeAt)
      if (info.plan.mode === 'direct') {
        origin.current = 0
        v.src = `/stream/${sessionId}/raw`
        if (resumeAt) v.currentTime = resumeAt
        v.play().catch(() => {})
      } else {
        startStream(resumeAt, info.plan.audioTrack)
      }
    })
    return () => { live = false }
    // Only when the plan first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, info, sessionId])

  // ---- Progress for the profile (Continue watching, taste) ------------------------------------------
  // Positions are film time (origin + the element's clock), never the converted stream's own clock.
  // Reported every 10 s while playing, on pause, once a seek has settled, at the end, and on the way out.
  const played = useRef(false)
  const lastPosition = useRef(0)
  const seekPending = useRef(false)
  const exited = useRef(false)
  const lastSent = useRef<{ position: number; at: number } | null>(null)
  const durationRef = useRef(0)
  durationRef.current = duration

  const report = useCallback((exit = false) => {
    if (exited.current || !played.current) return
    const d = durationRef.current
    if (!d || !IMDB_ID.test(imdbId) || !STREAM_ID.test(streamId)) return
    const v = video.current
    if (v && v.src && v.readyState > 0) lastPosition.current = origin.current + v.currentTime
    const position = Math.max(0, Math.min(lastPosition.current, d))
    const prev = lastSent.current
    if (prev && Math.abs(prev.position - position) < 1 && Date.now() - prev.at < 5000) return
    lastSent.current = { position, at: Date.now() }
    const body: ProgressRequest = { type, id: imdbId, streamId, position, duration: d }
    if (exit) api.progressOnExit(body)
    else api.progress(body).catch(() => {})
  }, [type, imdbId, streamId])
  const reportRef = useRef(report)
  reportRef.current = report

  useEffect(() => {
    if (phase !== 'ready') return
    const id = setInterval(() => {
      const v = video.current
      if (v && !v.paused && !v.seeking && !seekPending.current) report()
    }, REPORT_EVERY_MS)
    return () => clearInterval(id)
  }, [phase, report])

  useEffect(() => {
    const onHide = () => reportRef.current(true)
    const onVisibility = () => { if (document.visibilityState === 'hidden') reportRef.current(true) }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVisibility)
      // Leaving by the browser's Back: the element may already be detached, so this uses the last known time.
      reportRef.current(true)
    }
  }, [])

  const now = () => origin.current + (video.current?.currentTime ?? 0)

  const seekTo = useCallback((t: number) => {
    const v = video.current
    if (!v || !duration) return
    t = Math.max(0, Math.min(t, duration - 1))
    setTime(t)
    seekPending.current = true
    if (!usesConversion(audioTrack)) { v.currentTime = t; return }
    const local = t - origin.current
    for (let i = 0; i < v.buffered.length; i++) {
      if (local >= v.buffered.start(i) && local <= v.buffered.end(i) - 0.5) { v.currentTime = local; return }
    }
    startStream(t, audioTrack)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, audioTrack, startStream, mode])

  const togglePlay = useCallback(() => {
    const v = video.current
    if (!v) return
    if (v.paused) v.play().catch(() => {}); else v.pause()
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else document.documentElement.requestFullscreen().catch(() => {})
  }, [])

  // Video element events.
  useEffect(() => {
    const v = video.current
    if (!v) return
    const onTime = () => {
      setTime(origin.current + v.currentTime)
      if (v.src && !exited.current) lastPosition.current = origin.current + v.currentTime
    }
    const settled = () => { if (seekPending.current) { seekPending.current = false; reportRef.current() } }
    const onPlaying = () => { setBuffering(false); setPlaying(true); played.current = true; settled() }
    const onSeeked = () => { if (v.paused) settled() }
    const onPause = () => { setPlaying(false); if (!v.ended) reportRef.current() }
    const onEnded = () => reportRef.current()
    const onWaiting = () => setBuffering(true)
    const onCanPlay = () => setBuffering(false)
    const onVolume = () => { setMuted(v.muted); setVolume(v.volume) }
    const onError = () => {
      const code = v.error?.code
      if (!v.src || code === undefined) return
      setError(code === 4 ? 'The browser could not decode this stream.' : `Playback error (${v.error?.message || code}).`)
      setPhase('error')
    }
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('playing', onPlaying)
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('ended', onEnded)
    v.addEventListener('pause', onPause)
    v.addEventListener('waiting', onWaiting)
    v.addEventListener('canplay', onCanPlay)
    v.addEventListener('volumechange', onVolume)
    v.addEventListener('error', onError)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('playing', onPlaying)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('ended', onEnded)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('waiting', onWaiting)
      v.removeEventListener('canplay', onCanPlay)
      v.removeEventListener('volumechange', onVolume)
      v.removeEventListener('error', onError)
    }
  }, [])

  // Remember position every few seconds.
  useEffect(() => {
    if (!duration || time < 5) return
    const t = Math.floor(time / 5) * 5
    saveProgress(streamId, { t, d: duration, at: Date.now(), p: getActiveProfile() ?? undefined })
  }, [Math.floor(time / 5), duration, streamId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Subtitles: list, restore the viewer's last language, fetch cues.
  useEffect(() => {
    if (!stats?.fileName || !imdbId) return
    let live = true
    api.subtitles(type, streamId, stats.fileName).then(list => {
      if (!live) return
      setSubs(list)
      const lang = readKey('subs-lang')
      if (lang) {
        const best = list.filter(s => s.lang === lang).sort((a, b) => b.match - a.match)[0]
        if (best) setSubChoice(best)
      }
    }).catch(() => {})
    return () => { live = false }
  }, [stats?.fileName, type, streamId, imdbId])

  useEffect(() => {
    setCues([])
    if (!subChoice) return
    let live = true
    api.cues(subChoice.url).then(c => { if (live) setCues(c) }).catch(() => {})
    return () => { live = false }
  }, [subChoice])

  const chooseSub = (s: SubtitleOption | null) => {
    setSubChoice(s)
    setSubOffset(0)
    writeKey('subs-lang', s ? s.lang : null)
    setPanel('none')
  }

  const activeCue = useMemo(() => {
    const t = time - subOffset
    return cues.find(c => c.start <= t && t < c.end)
  }, [cues, time, subOffset])

  const chooseAudio = (i: number) => {
    setAudioTrack(i)
    setPanel('none')
    const t = now()
    if (mode === 'direct' && i === 0) {
      const v = video.current!
      origin.current = 0
      v.src = `/stream/${sessionId}/raw`
      v.currentTime = t
      v.play().catch(() => {})
    } else {
      startStream(t, i)
    }
  }

  // Auto-hide the controls while playing.
  const hideTimer = useRef<number | undefined>(undefined)
  const poke = useCallback(() => {
    setChrome(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setChrome(false), 2800)
  }, [])
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const v = video.current
      if (!v) return
      const k = e.key.toLowerCase()
      if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay() }
      else if (k === 'arrowright' || k === 'l') { e.preventDefault(); seekTo(now() + 10) }
      else if (k === 'arrowleft' || k === 'j') { e.preventDefault(); seekTo(now() - 10) }
      else if (k === 'f') toggleFullscreen()
      else if (k === 'm') v.muted = !v.muted
      else if (k === 'arrowup') { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1) }
      else if (k === 'arrowdown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1) }
      else if (k === 'i') setPanel(p => (p === 'info' ? 'none' : 'info'))
      else if (k === 'escape') setPanel('none')
      poke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekTo, toggleFullscreen, poke]) // eslint-disable-line react-hooks/exhaustive-deps

  const leave = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    report(true)
    exited.current = true
    const v = video.current
    if (v) { v.pause(); v.removeAttribute('src'); v.load() }
    if (history.length > 1) history.back(); else navigate(`/title/${type}/${imdbId}`)
  }

  const togglePin = () => {
    if (!sessionId || !stats) return
    const done = () => api.stats(sessionId).then(setStats).catch(() => {})
    if (stats.pinned) api.unkeep(sessionId, false).then(done).catch(() => {})
    else api.keep({ sessionId, type, imdbId, streamId, title: name }).then(setStats).catch(() => {})
  }

  const downloadLater = () => {
    let trackers: string[] = []
    try { trackers = JSON.parse(readSessionKey(`trackers:${infoHash}`) ?? '[]') } catch { /* none */ }
    setLater('saving')
    api.download({ infoHash, fileIdx, fileName, trackers, type, imdbId, streamId, title: name })
      .then(() => setLater('saved'))
      .catch(() => setLater('idle'))
  }
  const laterButton = later === 'saved'
    ? <button className="button primary" onClick={leave}>Back</button>
    : <button className="button secondary" disabled={later === 'saving'} onClick={downloadLater}><Download aria-hidden />Download to watch later</button>

  const showOverlay = phase !== 'ready' || (buffering && !error)
  const elapsed = Math.round((Date.now() - phaseStarted) / 1000)
  const backdrop = imdbId ? `https://images.metahub.space/background/large/${imdbId}/img` : undefined
  const logo = imdbId ? `https://images.metahub.space/logo/medium/${imdbId}/img` : undefined
  // "Show · S1E1 Pilot" → title and episode line.
  const [mainTitle, ...rest] = name.split(' · ')
  const episodeLine = rest.join(' · ')
  useDocumentTitle(mainTitle || undefined)
  const togglePanel = (p: 'audio' | 'subs' | 'info') => setPanel(cur => (cur === p ? 'none' : p))

  return (
    <div
      className={`player${chrome || !playing || panel !== 'none' ? ' show-chrome' : ''}${phase === 'ready' ? ' is-ready' : ''}`}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <video ref={video} className="player-video" playsInline onClick={() => { if (panel !== 'none') setPanel('none'); else togglePlay() }} onDoubleClick={toggleFullscreen} />

      {activeCue && <div className="subtitle" aria-live="off"><span>{activeCue.text}</span></div>}

      {showOverlay && (
        <div className={`player-overlay${phase === 'ready' ? ' light' : ''}`}>
          {phase !== 'ready' && backdrop && <img className="overlay-backdrop" src={backdrop} alt="" />}
          <div className="overlay-card" role="status">
            {phase === 'error' ? (
              <>
                <p className="overlay-title">{later === 'saved' ? 'Saved to Downloads' : 'This source didn’t work'}</p>
                <p className="overlay-detail">{later === 'saved' ? 'No peer has sent the file yet. nexttupp keeps trying in the background, even after a restart.' : error}</p>
                <div className="overlay-actions">
                  <button className="button primary" onClick={() => { setInfo(null); setStats(null); setAttempt(a => a + 1) }}>Try again</button>
                  <button className="button secondary" onClick={leave}>Pick another source</button>
                  {/* Never got a session: the swarm is the problem, so keeping it for later can still pay off. */}
                  {!stats && later !== 'saved' && laterButton}
                </div>
              </>
            ) : phase === 'ready' ? (
              <>
                <span className="spinner large" aria-hidden />
                <p className="overlay-title small">Buffering</p>
                {stats && <p className="overlay-detail">{stats.peers} peers · {speed(stats.downloadSpeed)}</p>}
                {info?.plan.mode !== 'direct' && <p className="overlay-hint">{info?.plan.reason}</p>}
              </>
            ) : (
              <>
                {mainTitle && <TitleArt as="div" className="overlay-logo" name={mainTitle} logo={logo} />}
                {episodeLine && <p className="overlay-episode">{episodeLine}</p>}
                <span className="loader" aria-hidden><span /></span>
                <p className="overlay-title">
                  {phase === 'connecting' ? 'Connecting to the swarm' : 'Reading the video'}
                </p>
                <p className="overlay-detail">
                  {phase === 'connecting' && (elapsed > 20 ? `Still asking peers for the torrent info (${elapsed}s). Slow swarms can take a minute.` : 'Asking peers for the torrent info…')}
                  {phase !== 'connecting' && stats && <>{stats.peers} peers · {speed(stats.downloadSpeed)}</>}
                </p>
                {phase === 'connecting' && later === 'saved' && <p className="overlay-hint">Saved to Downloads. You can leave; it keeps going.</p>}
                {phase === 'connecting' && elapsed > 15 && <div className="overlay-actions">{laterButton}</div>}
              </>
            )}
          </div>
        </div>
      )}

      <div className="player-top">
        <button className="round-button" onClick={leave} aria-label="Back"><ArrowLeft aria-hidden /></button>
      </div>

      {resumedFrom !== null && phase === 'ready' && time - resumedFrom < 8 && (
        <div className="toast" role="status">
          Resumed at <span className="tabular">{clock(resumedFrom)}</span>
          <button className="link" onClick={() => { setResumedFrom(null); seekTo(0) }}>Start over</button>
        </div>
      )}

      {phase === 'ready' && !showOverlay && (
        <div className="center-controls">
          <button className="icon-button" onClick={() => seekTo(now() - 10)} aria-label="Back 10 seconds"><RotateCcw aria-hidden /></button>
          <button className="icon-button play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause aria-hidden fill="currentColor" /> : <Play aria-hidden fill="currentColor" />}
          </button>
          <button className="icon-button" onClick={() => seekTo(now() + 10)} aria-label="Forward 10 seconds"><RotateCw aria-hidden /></button>
        </div>
      )}

      <div className="player-bottom">
        <div className="player-heading">
          <h1 className="player-title">{mainTitle}</h1>
          {(episodeLine || stats) && (
            <p className="player-sub">
              {episodeLine && <span className="player-episode">{episodeLine}</span>}
              {stats && <span className="player-file">{stats.fileName}</span>}
            </p>
          )}
        </div>
        {phase === 'ready' && (
          <>
            <Scrubber time={time} duration={duration} ranges={stats?.ranges ?? []} onSeek={seekTo} />
            <div className="controls">
              <div className="controls-group">
                <button className="icon-button play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
                  {playing ? <Pause aria-hidden fill="currentColor" /> : <Play aria-hidden fill="currentColor" />}
                </button>
                <button className="icon-button skip" onClick={() => seekTo(now() - 10)} aria-label="Back 10 seconds"><RotateCcw aria-hidden /></button>
                <button className="icon-button skip" onClick={() => seekTo(now() + 10)} aria-label="Forward 10 seconds"><RotateCw aria-hidden /></button>
                <div className="volume">
                  <button className="icon-button" onClick={() => { if (video.current) video.current.muted = !video.current.muted }} aria-label={muted ? 'Unmute' : 'Mute'}>
                    {muted || volume === 0 ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
                  </button>
                  <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume"
                    style={{ '--fill': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                    onChange={e => { const v = video.current; if (v) { v.volume = Number(e.target.value); v.muted = false } }} />
                </div>
                <span className="time">{clock(time)} <span className="muted">/ {clock(duration)}</span></span>
              </div>
              <div className="controls-group">
                {stats && (
                  <button className={`icon-button labeled${stats.pinned ? ' on' : ''}`} onClick={togglePin} aria-label={stats.pinned ? (stats.progress >= 1 ? 'Downloaded' : `Downloading, ${Math.floor(stats.progress * 100)}%`) : 'Download'} title={stats.pinned ? 'Downloading the whole file for offline viewing. Click to stop.' : 'Download the whole file to watch later without buffering'}>
                    {stats.pinned && stats.progress >= 1 ? <CircleArrowDown aria-hidden /> : <Download aria-hidden />}
                    {stats.pinned && stats.progress < 1
                      ? <span className="keep">{Math.floor(stats.progress * 100)}%</span>
                      : <span>{stats.pinned ? 'Downloaded' : 'Download'}</span>}
                  </button>
                )}
                {info && info.probe.audio.length > 1 && (
                  <button className={`icon-button${panel === 'audio' ? ' open' : ''}`} onClick={() => togglePanel('audio')} aria-label="Audio track" aria-expanded={panel === 'audio'}><AudioLines aria-hidden /></button>
                )}
                <button className={`icon-button${subChoice ? ' on' : ''}${panel === 'subs' ? ' open' : ''}`} onClick={() => togglePanel('subs')} aria-label="Subtitles" aria-expanded={panel === 'subs'}><Captions aria-hidden /></button>
                <button className={`icon-button${panel === 'info' ? ' open' : ''}`} onClick={() => togglePanel('info')} aria-label="Stream info" aria-expanded={panel === 'info'}><Info aria-hidden /></button>
                <button className="icon-button" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
                  {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {panel === 'audio' && info && (
        <div className="panel" role="dialog" aria-label="Audio track">
          <PanelHead title="Audio" onClose={() => setPanel('none')} />
          <div className="panel-body">
            {info.probe.audio.map((a, i) => (
              <button key={i} className={`panel-item${i === audioTrack ? ' active' : ''}`} onClick={() => chooseAudio(i)} aria-pressed={i === audioTrack}>
                <span className="panel-item-main">
                  <span className="panel-item-label">{a.title || (a.language ? languageName(a.language) : `Track ${i + 1}`)}</span>
                  <span className="panel-item-sub">{a.codec.toUpperCase()}{a.channels ? ` · ${a.channels} channels` : ''}</span>
                </span>
                {i === audioTrack && <Check className="panel-check" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
      )}

      {panel === 'subs' && (
        <div className="panel" role="dialog" aria-label="Subtitles">
          <PanelHead title="Subtitles" onClose={() => setPanel('none')} />
          <div className="panel-body">
            <button className={`panel-item${!subChoice ? ' active' : ''}`} onClick={() => chooseSub(null)} aria-pressed={!subChoice}>
              <span className="panel-item-main"><span className="panel-item-label">Off</span></span>
              {!subChoice && <Check className="panel-check" aria-hidden />}
            </button>
            {subs.length === 0 && <p className="panel-empty">No subtitles found for this title.</p>}
            {subs.slice(0, 40).map(s => (
              <button key={s.id} className={`panel-item${subChoice?.id === s.id ? ' active' : ''}`} onClick={() => chooseSub(s)} title={s.release} aria-pressed={subChoice?.id === s.id}>
                <span className="panel-item-main">
                  <span className="panel-item-label">{/^[a-z]{2,3}$/.test(s.label) ? languageName(s.label) : s.label}{s.match >= 40 && <span className="match">Matches release</span>}</span>
                  {s.release && <span className="panel-item-sub ellipsis">{s.release}</span>}
                </span>
                {subChoice?.id === s.id && <Check className="panel-check" aria-hidden />}
              </button>
            ))}
          </div>
          {subChoice && (
            <div className="sub-offset">
              <span>Timing</span>
              <span className="stepper">
                <button className="chip" onClick={() => setSubOffset(o => o - 0.5)} aria-label="Show subtitles 0.5 seconds earlier">−0.5s</button>
                <span className="tabular offset-value">{subOffset > 0 ? '+' : ''}{subOffset.toFixed(1)}s</span>
                <button className="chip" onClick={() => setSubOffset(o => o + 0.5)} aria-label="Show subtitles 0.5 seconds later">+0.5s</button>
              </span>
            </div>
          )}
        </div>
      )}

      {panel === 'info' && stats && (
        <div className="panel" role="dialog" aria-label="Stream info">
          <PanelHead title="Stream" onClose={() => setPanel('none')} />
          <dl className="info-grid">
            <dt>Playback</dt><dd>{info ? `${info.plan.mode} · ${info.plan.reason}` : '—'}</dd>
            <dt>Video</dt><dd>{info?.probe.video ? `${info.probe.video.codec} ${info.probe.video.width}×${info.probe.video.height}${info.probe.video.hdr ? ' HDR' : ''}` : '—'}</dd>
            <dt>Peers</dt><dd>{stats.peers}</dd>
            <dt>Download</dt><dd>{speed(stats.downloadSpeed)}</dd>
            <dt>On disk</dt><dd>{bytes(stats.downloaded)} of {bytes(stats.fileSize)} ({Math.floor(stats.progress * 100)}%)</dd>
            <dt>File</dt><dd className="break">{stats.fileName}</dd>
          </dl>
        </div>
      )}
    </div>
  )
}

function PanelHead ({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="panel-head">
      <p className="panel-title">{title}</p>
      <button className="icon-button small" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}><X aria-hidden /></button>
    </div>
  )
}

function Scrubber ({ time, duration, ranges, onSeek }: { time: number; duration: number; ranges: Array<[number, number]>; onSeek: (t: number) => void }) {
  const bar = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const frac = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  const shown = drag ?? (duration ? time / duration : 0)
  return (
    <div
      ref={bar}
      className={`scrubber${drag !== null ? ' dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${clock(time)} of ${clock(duration)}`}
      onPointerMove={e => { setHover(frac(e.clientX)); if (drag !== null) setDrag(frac(e.clientX)) }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(frac(e.clientX)) }}
      onPointerUp={e => { if (drag !== null) { onSeek(frac(e.clientX) * duration); setDrag(null) } }}
    >
      <div className="scrubber-track">
        {ranges.map(([a, b], i) => <span key={i} className="scrubber-downloaded" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />)}
        <span className="scrubber-played" style={{ width: `${shown * 100}%` }} />
      </div>
      <span className="scrubber-thumb" style={{ left: `${shown * 100}%` }} />
      {hover !== null && duration > 0 && <span className="scrubber-tip" style={{ left: `clamp(1.75rem, ${hover * 100}%, calc(100% - 1.75rem))` }}>{clock(hover * duration)}</span>}
    </div>
  )
}
