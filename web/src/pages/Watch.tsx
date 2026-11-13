import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, AudioLines, Captions, Cast, Check, CircleArrowDown, Download, Info, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, SkipForward, Tv, Volume2, VolumeX, X,
} from 'lucide-react'
import type { Episode, MediaType, ProbeResponse, ProgressRequest, WatchProgress } from '../../../shared/types.ts'
import { api, capsParam, type CastDevice, type CastStatus, getActiveProfile, type Cue, type Stats, type SubtitleOption, imageUrl } from '../api.ts'
import { detectCaps } from '../caps.ts'
import { bytes, clock, languageName, speed } from '../format.ts'
import { useDocumentTitle } from '../hooks.ts'
import { goBack } from '../router.ts'
import { readKey, readSessionKey, writeKey } from '../storage.ts'
import { isPrivate } from '../private.ts'
import { TitleArt } from '../components/TitleArt.tsx'
import { toast } from '../toast.ts'
import { watchSource } from './Title.tsx'

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

// Next episode: offered for the last stretch of an episode, and started after a short countdown once it ends.
const NEXT_OFFER_SEC = 40
const NEXT_COUNTDOWN = 8
const EPISODE_ID = /^tt\d+:(\d+):(\d+)$/

// Subtitle text size, as a multiple of the default; one choice for every title, saved as `nexttupp:subs-size`.
const SUB_SIZES = [0.75, 0.875, 1, 1.25, 1.5, 1.75]
function loadSubSize (): number {
  const n = Number(readKey('subs-size'))
  return SUB_SIZES.includes(n) ? n : 1
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

/** screen.orientation, with lock(): only Chromium has it, so TypeScript's DOM types leave it out. */
type LockableOrientation = ScreenOrientation & { lock?: (o: 'landscape') => Promise<void> }
const orientation = (): LockableOrientation | undefined => (screen as { orientation?: LockableOrientation }).orientation

export function Watch ({ query }: { query: URLSearchParams }) {
  const infoHash = query.get('ih') ?? ''
  const fileIdx = query.get('f') !== null ? Number(query.get('f')) : undefined
  const fileName = query.get('fn') ?? undefined
  const type = (query.get('type') ?? 'movie') as MediaType
  const imdbId = query.get('id') ?? ''
  const streamId = query.get('s') ?? imdbId
  const name = query.get('n') ?? ''
  const caps = useMemo(detectCaps, [])
  const backdrop = imdbId ? imageUrl(`https://images.metahub.space/background/large/${imdbId}/img`) : undefined

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
  const [panel, setPanel] = useState<'none' | 'audio' | 'subs' | 'info' | 'cast'>('none')
  // Casting: the computer plays this on a TV and the page becomes its remote.
  const [cast, setCast] = useState<CastStatus | null>(null)
  const castRef = useRef<CastStatus | null>(null)
  castRef.current = cast
  // The TV being connected to, until the computer says it's playing there.
  const [castPending, setCastPending] = useState<CastDevice | null>(null)
  const [castDevices, setCastDevices] = useState<CastDevice[] | null>(null)
  const [castScanning, setCastScanning] = useState(false)
  const [audioTrack, setAudioTrack] = useState<number | undefined>(undefined)
  const [resumedFrom, setResumedFrom] = useState<number | null>(null)

  const [subs, setSubs] = useState<SubtitleOption[]>([])
  const [subChoice, setSubChoice] = useState<SubtitleOption | null>(null)
  const [cues, setCues] = useState<Cue[]>([])
  const [subOffset, setSubOffset] = useState(0)
  const [ended, setEnded] = useState(false)
  const [subSize, setSubSize] = useState(loadSubSize)
  const stepSubSize = (by: 1 | -1) => {
    const next = SUB_SIZES[Math.min(SUB_SIZES.length - 1, Math.max(0, SUB_SIZES.indexOf(subSize) + by))]
    setSubSize(next)
    writeKey('subs-size', next === 1 ? null : String(next))
  }

  const sessionId = stats?.id
  const duration = info?.probe.durationSec ?? 0
  const mode = info?.plan.mode
  const remote = Boolean(cast?.active && cast.sessionId === sessionId)
  const casting = remote || castPending !== null

  // Where this profile left off, asked for straight away so it's known by the time the file is.
  const savedOnServer = useRef<Promise<WatchProgress | null | undefined> | null>(null)
  savedOnServer.current ??= serverPosition(type, imdbId, streamId)

  // 1. Open the torrent and pick the file.
  useEffect(() => {
    let live = true
    setPhase('connecting'); setPhaseStarted(Date.now()); setError(null)
    let trackers: string[] = []
    try { trackers = JSON.parse(readSessionKey(`trackers:${infoHash}`) ?? '[]') } catch { /* none */ }
    // The title it plays, so the server can delete the file once it's been watched.
    api.open({ infoHash, fileIdx, fileName, trackers, title: name, streamId: STREAM_ID.test(streamId) ? streamId : undefined })
      .then(s => { if (live) { setStats(s); setPhase('probing'); setPhaseStarted(Date.now()) } })
      .catch(err => { if (live) { setError(err.message); setPhase('error') } })
    return () => { live = false }
  }, [infoHash, fileIdx, fileName, name, streamId, attempt])

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
  const startStream = useCallback((t: number, audio: number | undefined, autoplay = true) => {
    const v = video.current
    if (!v || !sessionId) return
    streamStart.current = t
    origin.current = t
    if (info?.plan.copyVideo && t > 0) {
      api.streamStart(sessionId, t).then(r => {
        if (streamStart.current === t) { origin.current = r.start; setTime(r.start + v.currentTime) }
      }).catch(() => {})
    }
    setBuffering(autoplay)
    v.src = streamUrl(t, audio)
    if (autoplay) v.play().catch(() => {})
  }, [sessionId, streamUrl, info])

  /** Plays here at film time t: the file itself when the browser can, else the converted stream. */
  const attachLocal = useCallback((t: number, audio: number | undefined, autoplay = true) => {
    const v = video.current
    if (!v || !sessionId || !info) return
    if (info.plan.mode === 'direct' && !audio) {
      origin.current = 0
      v.src = `/stream/${sessionId}/raw`
      if (t) v.currentTime = t
      if (autoplay) v.play().catch(() => {})
      else setTime(t)
    } else {
      startStream(t, audio, autoplay)
      if (!autoplay) setTime(t)
    }
  }, [sessionId, info, startStream])

  // 4. Attach the source once we know the plan, resuming where the viewer left off: the profile's position on
  //    the server first; this browser's own record only when the server has none (and it was this profile's)
  //    or can't be reached.
  useEffect(() => {
    const v = video.current
    if (phase !== 'ready' || !info || !v || !sessionId) return
    let live = true
    const wait = new Promise<undefined>(resolve => setTimeout(resolve, 1500, undefined))
    // Already casting this (from another screen, or before a reload): be the remote, don't play here too.
    const casting = api.cast().catch(() => null)
    Promise.all([Promise.race([savedOnServer.current!, wait]), casting]).then(([server, c]) => {
      if (!live) return
      if (c?.active && c.sessionId === sessionId) { played.current = true; follow(c); setBuffering(false); return }
      const local = loadProgress(streamId)
      const mine = local && (local.p === undefined || local.p === getActiveProfile())
      const at = server ? (server.completed ? 0 : server.position) : server === null ? (mine ? local!.t : 0) : local?.t ?? 0
      const resumeAt = at > 30 && at < info.probe.durationSec - 90 ? at : 0
      if (resumeAt) setResumedFrom(resumeAt)
      attachLocal(resumeAt, info.plan.mode === 'direct' ? undefined : info.plan.audioTrack)
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
    const c = castRef.current
    if (c?.active && typeof c.position === 'number') lastPosition.current = c.position
    else if (v && v.src && v.readyState > 0) lastPosition.current = origin.current + v.currentTime
    const position = Math.max(0, Math.min(lastPosition.current, d))
    const prev = lastSent.current
    if (prev && Math.abs(prev.position - position) < 1 && Date.now() - prev.at < 5000) return
    lastSent.current = { position, at: Date.now() }
    const body: ProgressRequest = { type, id: imdbId, streamId, position, duration: d, from: readSessionKey(`from:${imdbId}`) ?? undefined }
    if (isPrivate()) return // private mode: no Continue watching, no taste
    if (exit) api.progressOnExit(body)
    else api.progress(body).catch(() => {})
  }, [type, imdbId, streamId])
  const reportRef = useRef(report)
  reportRef.current = report

  useEffect(() => {
    if (phase !== 'ready') return
    const id = setInterval(() => {
      const c = castRef.current
      if (c?.active) { if (c.state === 'playing') report(); return }
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

  const timeRef = useRef(0)
  timeRef.current = time
  const now = () => (castRef.current?.active ? timeRef.current : origin.current + (video.current?.currentTime ?? 0))

  const seekTo = useCallback((t: number) => {
    const v = video.current
    if (!v || !duration) return
    t = Math.max(0, Math.min(t, duration - 1))
    setTime(t)
    if (castRef.current?.active) {
      api.castControl({ action: 'seek', t }).then(c => { follow(c); played.current = true; reportRef.current() }).catch(err => toast(err.message))
      return
    }
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
    const c = castRef.current
    if (c?.active) {
      api.castControl({ action: c.state === 'paused' ? 'play' : 'pause' }).then(next => { follow(next); reportRef.current() }).catch(err => toast(err.message))
      return
    }
    const v = video.current
    if (!v) return
    if (v.paused) v.play().catch(() => {}); else v.pause()
  }, [])

  // ---- Casting -----------------------------------------------------------------------------------------
  const follow = useCallback((c: CastStatus) => {
    setCast(c)
    if (typeof c.position === 'number') setTime(c.position)
    setPlaying(c.state === 'playing')
    if (typeof c.volume === 'number') setVolume(c.volume)
    setMuted(Boolean(c.muted))
  }, [])

  /** Back to playing here, paused where the TV was. */
  const leaveRemote = useCallback((last: CastStatus, note?: string) => {
    const at = typeof last.position === 'number' ? last.position : timeRef.current
    setCast(null)
    setCastPending(null)
    lastPosition.current = at
    reportRef.current()
    const v = video.current
    if (v) { setVolume(v.volume); setMuted(v.muted) }
    setPlaying(false)
    attachLocal(last.state === 'ended' ? 0 : at, audioTrack, false)
    if (note) toast(note)
  }, [attachLocal, audioTrack])

  // The TV gets every subtitle in the panel as a track, so changing subtitles there doesn't reload the film.
  const castSub = (s: SubtitleOption, offset = 0) => ({ url: s.url, lang: /^[a-z]{2,3}$/.test(s.lang) ? s.lang : undefined, label: s.label.slice(0, 60), offset })
  const castSubs = () => subs.slice(0, 40).map(s => castSub(s))
  const castBody = (deviceId: string, t: number, audio: number | undefined, sub: SubtitleOption | null, offset: number) => ({
    deviceId, sessionId: sessionId!, t, audio,
    subtitle: sub ? castSub(sub, offset) : null,
    subtitles: castSubs(),
    title: name || undefined,
    streamId: STREAM_ID.test(streamId) ? streamId : undefined,
    image: backdrop,
  })

  const startCast = (device: CastDevice) => {
    if (!sessionId) return
    setPanel('none')
    const v = video.current
    const wasPlaying = Boolean(v && !v.paused)
    const t = now()
    if (v) { v.pause(); v.removeAttribute('src'); v.load() }
    setBuffering(false)
    setCastPending(device)
    api.castStart(castBody(device.id, t, audioTrack, subChoice, subOffset))
      .then(c => { played.current = true; follow(c); setCastPending(null) })
      .catch(err => {
        setCastPending(null)
        attachLocal(t, audioTrack, wasPlaying)
        toast(err.message || 'Couldn’t play on that TV')
      })
  }

  /** Same TV, same place, another audio track: the TV reloads the film. */
  const recast = (audio: number | undefined) => {
    const c = castRef.current
    if (!c?.active || !c.device) return
    const device = { id: c.device.id, name: c.device.name, model: '' }
    setCastPending(device)
    api.castStart(castBody(device.id, timeRef.current, audio, subChoice, subOffset))
      .then(next => { follow(next); setCastPending(null) })
      .catch(err => { setCastPending(null); leaveRemote(c, err.message || 'The TV stopped playing') })
  }

  const stopCast = () => {
    api.castStop().then(last => leaveRemote(last)).catch(err => toast(err.message))
  }

  // While casting, follow the TV (and notice when it finishes, fails, or another screen stops it).
  useEffect(() => {
    if (!remote) return
    const id = setInterval(() => {
      if (document.hidden || castPending) return
      api.cast().then(c => {
        if (castRef.current?.sessionId !== sessionId || !castRef.current?.active) return
        if (c.active && c.sessionId === sessionId) { follow(c); return }
        const last = { ...castRef.current, ...(c.sessionId === sessionId ? c : {}) }
        const tv = castRef.current.device?.name ?? 'the TV'
        leaveRemote(last, c.state === 'ended' ? `Finished on ${tv}`
          : c.state === 'error' ? (c.error || `${tv} stopped playing`)
            : `Stopped playing on ${tv}`)
      }).catch(() => {})
    }, 1000)
    return () => clearInterval(id)
  }, [remote, castPending, sessionId, follow, leaveRemote])

  const openCastPanel = () => {
    if (panel === 'cast') { setPanel('none'); return }
    setPanel('cast')
    setCastScanning(true)
    api.castDevices().then(r => setCastDevices(d => (d && d.length > r.devices.length ? d : r.devices))).catch(() => {})
    api.castDevices(true).then(r => setCastDevices(r.devices)).catch(() => setCastDevices(d => d ?? [])).finally(() => setCastScanning(false))
  }

  const setRemoteVolume = (body: { level?: number; muted?: boolean }) => {
    if (body.level !== undefined) setVolume(body.level)
    if (body.muted !== undefined) setMuted(body.muted)
    api.castControl({ action: 'volume', ...body }).then(follow).catch(err => toast(err.message))
  }

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return }
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      // On a phone, a wide picture turns sideways to fill the screen, as in other video apps. Browsers allow
      // the lock only in fullscreen and only on phones and tablets (Android); elsewhere it just fails.
      const v = video.current
      if (v && v.videoWidth > 0 && v.videoWidth < v.videoHeight) return
      orientation()?.lock?.('landscape').catch(() => {})
    }).catch(() => {})
  }, [])

  // Video element events.
  useEffect(() => {
    const v = video.current
    if (!v) return
    // No browser-made cast button (Chrome on Android overlays one on every video). A cast started from it belongs
    // to this tab and ends when the phone sleeps; ours runs from the computer and keeps going.
    v.disableRemotePlayback = true
    v.setAttribute('x-webkit-airplay', 'deny')
    const onTime = () => {
      setTime(origin.current + v.currentTime)
      if (v.src && !exited.current) lastPosition.current = origin.current + v.currentTime
    }
    const settled = () => { if (seekPending.current) { seekPending.current = false; reportRef.current() } }
    const onPlaying = () => { setBuffering(false); setPlaying(true); setEnded(false); played.current = true; settled() }
    const onSeeked = () => { if (v.paused) settled() }
    const onPause = () => { setPlaying(false); if (!v.ended) reportRef.current() }
    const onEnded = () => { setEnded(true); reportRef.current() }
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
    // On the TV only the subtitle track changes; the film plays on.
    if (castRef.current?.active) api.castControl({ action: 'subtitle', subtitle: s ? castSub(s) : null, subtitles: castSubs() }).then(follow).catch(err => toast(err.message))
  }

  const activeCue = useMemo(() => {
    const t = time - subOffset
    return cues.find(c => c.start <= t && t < c.end)
  }, [cues, time, subOffset])

  const chooseAudio = (i: number) => {
    setAudioTrack(i)
    setPanel('none')
    if (castRef.current?.active) { recast(i); return }
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
    const onFs = () => {
      setFullscreen(Boolean(document.fullscreenElement))
      if (!document.fullscreenElement) try { orientation()?.unlock() } catch { /* never locked */ }
    }
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
      else if (castRef.current?.active) {
        const c = castRef.current
        const level = typeof c.volume === 'number' ? c.volume : 0.5
        if (k === 'm') setRemoteVolume({ muted: !c.muted })
        else if (k === 'arrowup') { e.preventDefault(); setRemoteVolume({ level: Math.min(1, Math.round((level + 0.1) * 20) / 20) }) }
        else if (k === 'arrowdown') { e.preventDefault(); setRemoteVolume({ level: Math.max(0, Math.round((level - 0.1) * 20) / 20) }) }
      }
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

  // ---- Next episode -------------------------------------------------------------------------
  const [next, setNext] = useState<{ ep: Episode; series: string } | null>(null)
  const [nextHidden, setNextHidden] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [goingNext, setGoingNext] = useState(false)
  useEffect(() => {
    const m = EPISODE_ID.exec(streamId)
    if (type !== 'series' || !m || !IMDB_ID.test(imdbId)) return
    let gone = false
    api.title('series', imdbId).then(t => {
      const i = t.episodes.findIndex(e => e.season === Number(m[1]) && e.episode === Number(m[2]))
      const ep = i >= 0 ? t.episodes.slice(i + 1).find(e => e.season > 0) : undefined
      if (!gone && ep && !(ep.released && Date.parse(ep.released) > Date.now())) setNext({ ep, series: t.name })
    }).catch(() => {})
    return () => { gone = true }
  }, [type, imdbId, streamId])

  /** Plays the next episode: from this same torrent when it has it (a season pack), else the best source. */
  const goNext = useCallback(() => {
    if (!next || goingNext) return
    const { ep, series } = next
    setGoingNext(true)
    setCountdown(null)
    api.sources('series', ep.id).then(r => {
      const src = r.sources.find(x => x.infoHash.toLowerCase() === infoHash.toLowerCase()) ?? r.sources[0]
      if (!src) { setGoingNext(false); toast(`No sources found for S${ep.season}E${ep.episode} yet.`); return }
      report(true)
      exited.current = true
      watchSource(src, { type: 'series', imdbId, streamId: ep.id, name: `${series} · S${ep.season}E${ep.episode} ${ep.name}` }, { replace: true })
    }).catch(err => { setGoingNext(false); toast(`Couldn’t find the next episode. ${(err as Error).message}`) })
  }, [next, goingNext, infoHash, imdbId, report])

  const offerNext = Boolean(next) && !nextHidden && !casting && phase === 'ready' && duration > 0 && (ended || duration - time <= NEXT_OFFER_SEC)
  useEffect(() => {
    if (!ended || !offerNext || goingNext) { setCountdown(null); return }
    setCountdown(NEXT_COUNTDOWN)
    const t = setInterval(() => setCountdown(c => (c === null ? null : Math.max(0, c - 1))), 1000)
    return () => clearInterval(t)
  }, [ended, offerNext, goingNext])
  useEffect(() => { if (countdown === 0) goNext() }, [countdown, goNext])

  const leave = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    report(true)
    exited.current = true
    const v = video.current
    if (v) { v.pause(); v.removeAttribute('src'); v.load() }
    goBack(`/title/${type}/${imdbId}`)
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

  const showOverlay = phase !== 'ready' || (buffering && !error && !casting)
  const elapsed = Math.round((Date.now() - phaseStarted) / 1000)
  const logo = imdbId ? imageUrl(`https://images.metahub.space/logo/medium/${imdbId}/img`) : undefined
  // "Show · S1E1 Pilot" → title and episode line.
  const [mainTitle, ...rest] = name.split(' · ')
  const episodeLine = rest.join(' · ')
  useDocumentTitle(mainTitle || undefined)
  const togglePanel = (p: 'audio' | 'subs' | 'info') => setPanel(cur => (cur === p ? 'none' : p))
  const castName = castPending?.name ?? cast?.device?.name ?? 'the TV'
  const castLine = castPending ? `Connecting to ${castName}…`
    : cast?.state === 'paused' ? `Paused on ${castName}`
      : cast?.state === 'loading' || cast?.state === 'buffering' || cast?.state === 'connecting' ? `Loading on ${castName}…`
        : `Playing on ${castName}`

  return (
    <div
      className={`player${chrome || !playing || panel !== 'none' || casting ? ' show-chrome' : ''}${phase === 'ready' ? ' is-ready' : ''}${casting ? ' is-casting' : ''}`}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <video ref={video} className="player-video" playsInline onClick={() => { if (panel !== 'none') setPanel('none'); else togglePlay() }} onDoubleClick={toggleFullscreen} />

      {activeCue && !casting && <div className="subtitle" aria-live="off" style={{ '--sub-scale': subSize } as CSSProperties}><span>{activeCue.text}</span></div>}

      {casting && (
        <div className="cast-screen">
          {backdrop && <img className="overlay-backdrop" src={backdrop} alt="" />}
          <div className="cast-card" role="status">
            <Tv className="cast-tv" aria-hidden />
            <p className="cast-line">{castLine}</p>
            <div className="cast-transport">
              <button className="icon-button" onClick={() => seekTo(now() - 10)} aria-label="Back 10 seconds" disabled={castPending !== null}><RotateCcw aria-hidden /></button>
              <button className="icon-button play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} disabled={castPending !== null}>
                {playing ? <Pause aria-hidden fill="currentColor" /> : <Play aria-hidden fill="currentColor" />}
              </button>
              <button className="icon-button" onClick={() => seekTo(now() + 10)} aria-label="Forward 10 seconds" disabled={castPending !== null}><RotateCw aria-hidden /></button>
            </div>
            {cast?.mode && cast.mode !== 'direct' && !castPending && <p className="overlay-hint">{cast.mode === 'transcode' ? 'Converting the video for the TV' : 'Repackaging the file for the TV'}</p>}
            <button className="button secondary" onClick={stopCast} disabled={Boolean(castPending)}>Stop casting</button>
          </div>
        </div>
      )}

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

      {offerNext && next && (
        <div className="next-episode" role="group" aria-label="Next episode">
          <button className="button primary" onClick={goNext} disabled={goingNext}>
            <SkipForward aria-hidden />
            <span className="next-episode-text">
              <span>{goingNext ? 'Finding a source…' : countdown !== null ? `Next episode in ${countdown}` : 'Next episode'}</span>
              <span className="next-episode-name ellipsis">S{next.ep.season}E{next.ep.episode} · {next.ep.name}</span>
            </span>
          </button>
          <button className="icon-button small" onClick={() => { setNextHidden(true); setCountdown(null) }} aria-label="Not now"><X aria-hidden /></button>
        </div>
      )}

      <div className="player-top">
        <button className="round-button" onClick={leave} aria-label="Back"><ArrowLeft aria-hidden /></button>
      </div>

      {resumedFrom !== null && phase === 'ready' && !casting && time - resumedFrom < 8 && (
        <div className="toast" role="status">
          Resumed at <span className="tabular">{clock(resumedFrom)}</span>
          <button className="link" onClick={() => { setResumedFrom(null); seekTo(0) }}>Start over</button>
        </div>
      )}

      {phase === 'ready' && !showOverlay && !casting && (
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
                  <button className="icon-button" onClick={() => { if (remote) setRemoteVolume({ muted: !muted }); else if (video.current) video.current.muted = !video.current.muted }} aria-label={muted ? 'Unmute' : 'Mute'} disabled={castPending !== null}>
                    {muted || volume === 0 ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
                  </button>
                  <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label={remote ? 'TV volume' : 'Volume'}
                    style={{ '--fill': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                    onChange={e => {
                      const level = Number(e.target.value)
                      if (remote) { setRemoteVolume({ level, ...(muted ? { muted: false } : {}) }); return }
                      const v = video.current; if (v) { v.volume = level; v.muted = false }
                    }} />
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
                <button className={`icon-button${casting ? ' on' : ''}${panel === 'cast' ? ' open' : ''}`} onClick={openCastPanel} aria-label={casting ? `Casting to ${castName}` : 'Cast to a TV'} aria-expanded={panel === 'cast'}><Cast aria-hidden /></button>
                {!casting && (
                  <button className="icon-button" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
                    {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
                  </button>
                )}
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
          {subChoice && !casting && (
            <div className="sub-offset">
              <span>Size</span>
              <span className="stepper">
                <button className="chip" onClick={() => stepSubSize(-1)} disabled={subSize === SUB_SIZES[0]} aria-label="Smaller subtitles">A−</button>
                <span className="tabular offset-value">{Math.round(subSize * 100)}%</span>
                <button className="chip" onClick={() => stepSubSize(1)} disabled={subSize === SUB_SIZES[SUB_SIZES.length - 1]} aria-label="Bigger subtitles">A+</button>
              </span>
            </div>
          )}
          {subChoice && !casting && (
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

      {panel === 'cast' && (
        <div className="panel" role="dialog" aria-label="Cast to a TV">
          <PanelHead title="Play on a TV" onClose={() => setPanel('none')} />
          <div className="panel-body">
            {casting && (
              <button className="panel-item" onClick={() => { setPanel('none'); stopCast() }} disabled={Boolean(castPending)}>
                <span className="panel-item-main">
                  <span className="panel-item-label">Stop casting</span>
                  <span className="panel-item-sub">Keep watching here, from the same place</span>
                </span>
              </button>
            )}
            {(castDevices ?? []).map(d => {
              const current = casting && (castPending?.id ?? cast?.device?.id) === d.id
              return (
                <button key={d.id} className={`panel-item${current ? ' active' : ''}`} onClick={() => { if (!current) startCast(d) }} aria-pressed={current} disabled={Boolean(castPending)}>
                  <Tv className="panel-icon" aria-hidden />
                  <span className="panel-item-main">
                    <span className="panel-item-label">{d.name}</span>
                    {d.model && <span className="panel-item-sub">{d.model}</span>}
                  </span>
                  {current && <Check className="panel-check" aria-hidden />}
                </button>
              )
            })}
            {castScanning
              ? <p className="panel-empty cast-scanning"><span className="spinner" aria-hidden />Looking for TVs…</p>
              : castDevices && castDevices.length === 0 && <p className="panel-empty">No TVs found. Turn the TV on and check it's on the same Wi-Fi as this computer.</p>}
          </div>
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
