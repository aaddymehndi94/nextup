import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, AudioLines, Captions, Download, Info, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX,
} from 'lucide-react'
import type { MediaType, ProbeResponse } from '../../../shared/types.ts'
import { api, capsParam, type Cue, type Stats, type SubtitleOption } from '../api.ts'
import { detectCaps } from '../caps.ts'
import { bytes, clock, speed } from '../format.ts'
import { navigate } from '../router.ts'

type Phase = 'connecting' | 'probing' | 'ready' | 'error'

interface Progress { t: number; d: number; at: number }
const progressKey = (streamId: string) => `nextup:progress:${streamId}`
function loadProgress (streamId: string): Progress | null {
  try { return JSON.parse(localStorage.getItem(progressKey(streamId)) ?? 'null') } catch { return null }
}
function saveProgress (streamId: string, p: Progress) {
  try { localStorage.setItem(progressKey(streamId), JSON.stringify(p)) } catch { /* storage unavailable */ }
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

  // 1. Open the torrent and pick the file.
  useEffect(() => {
    let live = true
    setPhase('connecting'); setPhaseStarted(Date.now()); setError(null)
    let trackers: string[] = []
    try { trackers = JSON.parse(sessionStorage.getItem(`nextup:trackers:${infoHash}`) ?? '[]') } catch { /* none */ }
    api.open({ infoHash, fileIdx, fileName, trackers, title: name })
      .then(s => { if (live) { setStats(s); setPhase('probing'); setPhaseStarted(Date.now()) } })
      .catch(err => { if (live) { setError(err.message); setPhase('error') } })
    return () => { live = false }
  }, [infoHash, fileIdx, fileName, name, attempt])

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

  // 4. Attach the source once we know the plan, resuming where the viewer left off.
  useEffect(() => {
    const v = video.current
    if (phase !== 'ready' || !info || !v || !sessionId) return
    const saved = loadProgress(streamId)
    const resumeAt = saved && saved.t > 30 && saved.t < info.probe.durationSec - 90 ? saved.t : 0
    if (resumeAt) setResumedFrom(resumeAt)
    if (info.plan.mode === 'direct') {
      origin.current = 0
      v.src = `/stream/${sessionId}/raw`
      if (resumeAt) v.currentTime = resumeAt
      v.play().catch(() => {})
    } else {
      startStream(resumeAt, info.plan.audioTrack)
    }
    // Only when the plan first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, info, sessionId])

  const now = () => origin.current + (video.current?.currentTime ?? 0)

  const seekTo = useCallback((t: number) => {
    const v = video.current
    if (!v || !duration) return
    t = Math.max(0, Math.min(t, duration - 1))
    setTime(t)
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
    }
    const onPlaying = () => { setBuffering(false); setPlaying(true) }
    const onPause = () => setPlaying(false)
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
    v.addEventListener('pause', onPause)
    v.addEventListener('waiting', onWaiting)
    v.addEventListener('canplay', onCanPlay)
    v.addEventListener('volumechange', onVolume)
    v.addEventListener('error', onError)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('playing', onPlaying)
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
    saveProgress(streamId, { t, d: duration, at: Date.now() })
  }, [Math.floor(time / 5), duration, streamId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Subtitles: list, restore the viewer's last language, fetch cues.
  useEffect(() => {
    if (!stats?.fileName || !imdbId) return
    let live = true
    api.subtitles(type, streamId, stats.fileName).then(list => {
      if (!live) return
      setSubs(list)
      const lang = (() => { try { return localStorage.getItem('nextup:subs-lang') } catch { return null } })()
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
    try { if (s) localStorage.setItem('nextup:subs-lang', s.lang); else localStorage.removeItem('nextup:subs-lang') } catch { /* ignore */ }
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
    const v = video.current
    if (v) { v.pause(); v.removeAttribute('src'); v.load() }
    if (history.length > 1) history.back(); else navigate(`/title/${type}/${imdbId}`)
  }

  const togglePin = () => {
    if (!sessionId || !stats) return
    ;(stats.pinned ? api.unpin(sessionId) : api.pin(sessionId)).then(setStats).catch(() => {})
  }

  const showOverlay = phase !== 'ready' || (buffering && !error)
  const elapsed = Math.round((Date.now() - phaseStarted) / 1000)
  const backdrop = imdbId ? `https://images.metahub.space/background/large/${imdbId}/img` : undefined

  return (
    <div
      className={`player${chrome || !playing || panel !== 'none' ? ' show-chrome' : ''}`}
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
                <p className="overlay-title">This source didn’t work</p>
                <p className="overlay-detail">{error}</p>
                <div className="overlay-actions">
                  <button className="button primary" onClick={() => { setInfo(null); setStats(null); setAttempt(a => a + 1) }}>Try again</button>
                  <button className="button ghost" onClick={leave}>Pick another source</button>
                </div>
              </>
            ) : (
              <>
                <span className="spinner large" aria-hidden />
                <p className="overlay-title">
                  {phase === 'connecting' ? 'Connecting to the swarm' : phase === 'probing' ? 'Reading the video' : 'Buffering'}
                </p>
                <p className="overlay-detail">
                  {phase === 'connecting' && (elapsed > 20 ? `Still asking peers for the torrent info (${elapsed}s). Slow swarms can take a minute.` : 'Asking peers for the torrent info…')}
                  {phase !== 'connecting' && stats && <>{stats.peers} peers · {speed(stats.downloadSpeed)}</>}
                </p>
                {phase === 'ready' && info?.plan.mode !== 'direct' && <p className="overlay-hint">{info?.plan.reason}</p>}
              </>
            )}
          </div>
        </div>
      )}

      <div className="player-top">
        <button className="icon-button" onClick={leave} aria-label="Back"><ArrowLeft size={24} /></button>
        <div className="player-heading">
          <span className="player-title">{name}</span>
          {stats && <span className="player-file">{stats.fileName}</span>}
        </div>
      </div>

      {resumedFrom !== null && phase === 'ready' && time - resumedFrom < 8 && (
        <div className="toast">
          Resumed at {clock(resumedFrom)}
          <button className="link" onClick={() => { setResumedFrom(null); seekTo(0) }}>Start over</button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="player-bottom">
          <Scrubber time={time} duration={duration} ranges={stats?.ranges ?? []} onSeek={seekTo} />
          <div className="controls">
            <button className="icon-button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
            </button>
            <button className="icon-button" onClick={() => seekTo(now() - 10)} aria-label="Back 10 seconds"><RotateCcw size={22} /></button>
            <button className="icon-button" onClick={() => seekTo(now() + 10)} aria-label="Forward 10 seconds"><RotateCw size={22} /></button>
            <div className="volume">
              <button className="icon-button" onClick={() => { if (video.current) video.current.muted = !video.current.muted }} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted || volume === 0 ? <VolumeX size={22} /> : <Volume2 size={22} />}
              </button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume"
                onChange={e => { const v = video.current; if (v) { v.volume = Number(e.target.value); v.muted = false } }} />
            </div>
            <span className="time">{clock(time)} <span className="muted">/ {clock(duration)}</span></span>
            <span className="spacer" />
            {stats && (
              <button className={`icon-button labeled${stats.pinned ? ' on' : ''}`} onClick={togglePin} title={stats.pinned ? 'Downloading the whole file for offline viewing. Click to stop.' : 'Download the whole file to watch later without buffering'}>
                <Download size={20} />
                <span>{stats.pinned ? (stats.progress >= 1 ? 'Downloaded' : `${Math.floor(stats.progress * 100)}%`) : 'Download'}</span>
              </button>
            )}
            {info && info.probe.audio.length > 1 && (
              <button className="icon-button" onClick={() => setPanel(p => (p === 'audio' ? 'none' : 'audio'))} aria-label="Audio track" aria-expanded={panel === 'audio'}><AudioLines size={22} /></button>
            )}
            <button className={`icon-button${subChoice ? ' on' : ''}`} onClick={() => setPanel(p => (p === 'subs' ? 'none' : 'subs'))} aria-label="Subtitles" aria-expanded={panel === 'subs'}><Captions size={22} /></button>
            <button className="icon-button" onClick={() => setPanel(p => (p === 'info' ? 'none' : 'info'))} aria-label="Stream info" aria-expanded={panel === 'info'}><Info size={22} /></button>
            <button className="icon-button" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
              {fullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
            </button>
          </div>
        </div>
      )}

      {panel === 'audio' && info && (
        <div className="panel" role="dialog" aria-label="Audio track">
          <p className="panel-title">Audio</p>
          {info.probe.audio.map((a, i) => (
            <button key={i} className={`panel-item${i === audioTrack ? ' active' : ''}`} onClick={() => chooseAudio(i)}>
              {a.title || a.language?.toUpperCase() || `Track ${i + 1}`} <span className="muted">{a.codec.toUpperCase()}{a.channels ? ` ${a.channels}ch` : ''}</span>
            </button>
          ))}
        </div>
      )}

      {panel === 'subs' && (
        <div className="panel" role="dialog" aria-label="Subtitles">
          <p className="panel-title">Subtitles</p>
          <button className={`panel-item${!subChoice ? ' active' : ''}`} onClick={() => chooseSub(null)}>Off</button>
          {subs.length === 0 && <p className="muted small">No subtitles found for this title.</p>}
          {subs.slice(0, 40).map(s => (
            <button key={s.id} className={`panel-item${subChoice?.id === s.id ? ' active' : ''}`} onClick={() => chooseSub(s)} title={s.release}>
              {s.label} {s.match >= 40 && <span className="tag">matches release</span>}
              <span className="muted small ellipsis">{s.release}</span>
            </button>
          ))}
          {subChoice && (
            <div className="sub-offset">
              <span>Timing</span>
              <button className="chip" onClick={() => setSubOffset(o => o - 0.5)}>−0.5s</button>
              <span className="tabular">{subOffset > 0 ? '+' : ''}{subOffset.toFixed(1)}s</span>
              <button className="chip" onClick={() => setSubOffset(o => o + 0.5)}>+0.5s</button>
            </div>
          )}
        </div>
      )}

      {panel === 'info' && stats && (
        <div className="panel" role="dialog" aria-label="Stream info">
          <p className="panel-title">Stream</p>
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
      className="scrubber"
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
      {hover !== null && duration > 0 && <span className="scrubber-tip" style={{ left: `${hover * 100}%` }}>{clock(hover * duration)}</span>}
    </div>
  )
}
