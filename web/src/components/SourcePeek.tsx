import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, Play, Square, X } from 'lucide-react'
import type { MediaType, ProbeResponse, Source } from '../../../shared/types.ts'
import { api, capsParam, type Stats } from '../api.ts'
import { detectCaps } from '../caps.ts'
import { bytes, clock, RES_LABEL } from '../format.ts'
import { pause as pauseMusic } from '../music/player.ts'
import { quickLook, stillTimes } from '../peek.ts'

// The quick look at one source, before committing to it: what the file really is (from its header, in seconds),
// six stills from across the film (each costs only the pieces around one keyframe), and a short clip with sound
// from whichever moment looks like people talking. ADR 0001 has the why.

type Ctx = { type: MediaType; imdbId: string; streamId: string; name: string }
interface Peeked { stats: Stats; info: ProbeResponse }

const STILLS = 6
/** Long enough to hear a few lines and see motion; short enough that it stays a look, not a watch. */
const CLIP_SEC = 20

const opened = new Map<string, Promise<Peeked>>()

/** Opens the source and reads its header, once; hovering Preview starts it so the look is ready on click. */
export function warmPeek (s: Source, ctx: Ctx): Promise<Peeked> {
  const key = `${s.infoHash}:${s.fileIdx ?? ''}`
  let p = opened.get(key)
  if (!p) {
    p = api.open({ infoHash: s.infoHash, fileIdx: s.fileIdx, fileName: s.fileName, trackers: s.trackers, title: ctx.name, streamId: ctx.streamId })
      .then(async stats => ({ stats, info: await api.probe(stats.id, detectCaps()) }))
    p.catch(() => opened.delete(key))
    opened.set(key, p)
  }
  return p
}

type Clip = 'off' | 'starting' | 'playing'

export function SourcePeek ({ source, ctx, saved, onPlay, onDownload, onClose }: {
  source: Source
  ctx: Ctx
  saved: boolean
  onPlay: () => void
  onDownload: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [peek, setPeek] = useState<Peeked | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)
  const [loaded, setLoaded] = useState<Record<number, 'ok' | 'failed'>>({})
  const [picked, setPicked] = useState<number | null>(null)
  const [clip, setClip] = useState<Clip>('off')
  const [clipAt, setClipAt] = useState(0)

  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
    return () => back?.focus()
  }, [])

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => setSlow(true), 8000)
    warmPeek(source, ctx).then(p => live && setPeek(p), (err: Error) => live && setError(err.message)).finally(() => clearTimeout(timer))
    return () => { live = false; clearTimeout(timer) }
    // Not on ctx: Title rebuilds it each render, and the source alone names the look.
  }, [source])

  const id = peek?.stats.id
  const probe = peek?.info.probe
  const times = probe ? stillTimes(probe.durationSec, STILLS) : []
  const look = peek && probe ? quickLook(probe, source.release.resolution, peek.stats.fileSize || source.sizeBytes || 0) : null
  // The big picture: the one picked, else the first still to arrive.
  const shown = picked ?? times.findIndex((_, i) => loaded[i] === 'ok')
  const at = shown >= 0 ? times[shown] : undefined
  const noStills = times.length > 0 && times.every((_, i) => loaded[i] === 'failed')
  const frame = (t: number) => `/api/sessions/${id}/frame?t=${t}`

  const stopClip = () => {
    const v = video.current
    if (v) { v.pause(); v.removeAttribute('src'); v.load() }
    setClip('off')
  }

  const playClip = () => {
    const v = video.current
    if (!v || !peek || at === undefined) return
    const { plan } = peek.info
    pauseMusic()
    setClip('starting'); setClipAt(0)
    if (plan.mode === 'direct') {
      v.src = `/stream/${peek.stats.id}/raw`
      v.currentTime = at
    } else {
      v.src = `/stream/${peek.stats.id}/play.mp4?t=${at.toFixed(2)}&caps=${capsParam(detectCaps())}&audio=${plan.audioTrack}`
    }
    v.play().catch(() => setClip('off'))
  }

  const onTime = () => {
    const v = video.current
    if (!v || at === undefined || !peek) return
    const elapsed = peek.info.plan.mode === 'direct' ? v.currentTime - at : v.currentTime
    setClipAt(Math.max(0, elapsed))
    if (elapsed >= CLIP_SEC) stopClip()
  }

  const pick = (i: number) => { stopClip(); setPicked(i) }
  const name = source.fileName && source.fileName !== source.title ? source.fileName : source.title
  const aspect = probe?.video ? `${probe.video.width} / ${probe.video.height}` : '16 / 9'
  const status = error
    ? 'Couldn’t read this file. Sources with more seeds open faster.'
    : slow ? 'Still finding peers. Sources with more seeds open faster.' : 'Reading the file…'

  return (
    <dialog
      ref={dialog}
      className="preview peek"
      aria-label={`Preview of ${name}`}
      onCancel={e => { e.preventDefault(); onClose() }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="preview-card">
        <div className={`peek-stage is-${clip}`} style={{ aspectRatio: aspect }}>
          {id && at !== undefined
            ? <img className="peek-big" src={frame(at)} alt={`The film at ${clock(at)}`} />
            : <div className={`peek-wait${error || noStills ? ' is-error' : ''}`} role="status" aria-live="polite" title={error ?? undefined}>{!error && !noStills && <span className="preview-spinner" aria-hidden />}<p>{noStills ? 'Couldn’t take stills from this file. The facts below still hold.' : probe ? 'Taking stills from across the film…' : status}</p></div>}
          <video ref={video} className="peek-clip" playsInline onPlaying={() => setClip('playing')} onTimeUpdate={onTime} onEnded={stopClip} onError={() => setClip('off')} />
          {clip === 'starting' && <span className="preview-spinner" aria-label="Starting the clip" />}
          {at !== undefined && (
            <div className="peek-controls">
              {clip === 'off'
                ? <button type="button" className="button secondary peek-listen" onClick={playClip}><Play aria-hidden fill="currentColor" />Play {CLIP_SEC} seconds</button>
                : <button type="button" className="button secondary peek-listen" onClick={stopClip}><Square aria-hidden fill="currentColor" />Stop</button>}
              <span className="peek-at">{clock(at + (clip === 'playing' ? clipAt : 0))}</span>
            </div>
          )}
          {clip === 'playing' && <span className="peek-progress" style={{ transform: `scaleX(${Math.min(1, clipAt / CLIP_SEC)})` }} aria-hidden />}
          <button type="button" className="round-button preview-close" aria-label="Close" data-tip="Close" onClick={onClose}><X aria-hidden /></button>
        </div>

        {!error && !noStills && <div className="peek-strip" role="group" aria-label="Stills from across the film">
          {(times.length ? times : Array.from({ length: STILLS }, () => -1)).map((t, i) => (
            <button
              key={i} type="button" className={`peek-thumb${shown === i ? ' is-on' : ''}${loaded[i] === 'failed' ? ' is-failed' : ''}`}
              disabled={t < 0 || loaded[i] !== 'ok'} aria-pressed={shown === i} aria-label={t < 0 ? 'Loading a still' : `Still at ${clock(t)}`}
              onClick={() => pick(i)}
            >
              {id && t >= 0 && loaded[i] !== 'failed' && (
                <img src={frame(t)} alt="" onLoad={() => setLoaded(l => ({ ...l, [i]: 'ok' }))} onError={() => setLoaded(l => ({ ...l, [i]: 'failed' }))} />
              )}
              {t >= 0 && <span className="peek-thumb-time">{clock(t)}</span>}
            </button>
          ))}
        </div>}

        <div className="preview-body peek-body">
          <div className="peek-head">
            <span className={`res res-${source.release.resolution}`}>{RES_LABEL[source.release.resolution]}</span>
            <p className="peek-name" title={name}>{name}</p>
          </div>
          {look
            ? (
              <dl className="peek-facts">
                <div><dt>Picture</dt><dd>{look.picture}</dd></div>
                <div><dt>Bitrate</dt><dd>{look.bitrate ?? '—'}<span className="peek-quiet"> · {bytes(peek!.stats.fileSize || source.sizeBytes)} over {clock(probe!.durationSec)}</span></dd></div>
                <div><dt>Sound</dt><dd>{look.audio.join(', ') || 'None'}</dd></div>
                <div><dt>Subtitles</dt><dd>{look.subtitles.join(', ') || 'None in the file'}</dd></div>
              </dl>
              )
            : !error && <div className="peek-facts is-loading" aria-hidden>{[0, 1, 2, 3].map(i => <span key={i} className="skeleton-line" />)}</div>}
          {look?.warnings.map(w => <p key={w} className="note warn"><AlertTriangle aria-hidden />{w}</p>)}
          {times.length > 0 && <p className="peek-hint">Pick a still with people talking, then play it to hear the dialogue.</p>}
          <div className="peek-actions">
            <button type="button" className="button primary" data-autofocus onClick={onPlay}><Play aria-hidden fill="currentColor" />Play this</button>
            <button type="button" className="button secondary" onClick={onDownload}>{saved ? <Check aria-hidden /> : <Download aria-hidden />}{saved ? 'Downloading' : 'Download'}</button>
          </div>
        </div>
      </div>
    </dialog>
  )
}
