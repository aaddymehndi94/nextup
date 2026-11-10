import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { Episode, HealthResponse, MediaType, RecItem, Source, SourcesResponse, TitleDetail, TitleState, WatchProgress } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { RES_LABEL } from '../format.ts'
import { useDocumentTitle, useLoaded } from '../hooks.ts'
import { navigate } from '../router.ts'
import { writeSessionKey } from '../storage.ts'
import { useTitleState } from '../taste.ts'
import { toast } from '../toast.ts'
import { RecCard } from '../components/RecCard.tsx'
import { PosterSkeleton } from '../components/PosterCard.tsx'
import { Row } from '../components/Row.tsx'
import { SourceList } from '../components/SourceList.tsx'
import { DismissLine, TasteButtons } from '../components/TitleActions.tsx'
import { TitleArt } from '../components/TitleArt.tsx'
import { TopBar } from '../components/TopBar.tsx'

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string }

/** Hands the chosen source to the player. Trackers ride in sessionStorage to keep the URL short. */
export function watchSource (s: Source, ctx: { type: MediaType; imdbId: string; streamId: string; name: string }, opts: { replace?: boolean } = {}) {
  writeSessionKey(`trackers:${s.infoHash}`, JSON.stringify(s.trackers))
  const q = new URLSearchParams({ ih: s.infoHash, type: ctx.type, id: ctx.imdbId, s: ctx.streamId, n: ctx.name })
  if (s.fileIdx !== undefined) q.set('f', String(s.fileIdx))
  if (s.fileName) q.set('fn', s.fileName)
  navigate(`/watch?${q}`, opts)
}

const released = (e: Episode) => !e.released || new Date(e.released) <= new Date()

/**
 * The episode to open on: the one asked for (?play from Continue watching, or ?season), else where this
 * profile left off (the next one if that episode was finished), else the first of season 1.
 */
function initialEpisode (episodes: Episode[], opts: { season: string | null; play: string | null; state: TitleState | null }): Episode | null {
  if (opts.play) {
    const [, s, e] = opts.play.split(':').map(Number)
    const ep = episodes.find(x => x.season === s && x.episode === e)
    if (ep) return ep
  }
  const season = Number(opts.season)
  if (season) return episodes.find(e => e.season === season) ?? episodes[0] ?? null
  const p = opts.state?.progress
  if (p && p.season !== undefined && p.episode !== undefined) {
    const i = episodes.findIndex(e => e.season === p.season && e.episode === p.episode)
    if (i >= 0) {
      const next = p.completed ? episodes.slice(i + 1).find(e => e.season > 0) : undefined
      return next && released(next) ? next : episodes[i]
    }
  }
  return episodes.find(e => e.season > 0) ?? episodes[0] ?? null
}

/** Saved progress for this movie or episode, when it is worth resuming (not the first or last minutes). */
function resumable (state: TitleState | null, streamId: string | null): WatchProgress | null {
  if (!state || !streamId) return null
  const all = state.episodes ?? (state.progress ? [state.progress] : [])
  const p = all.find(x => x.streamId === streamId)
  return p && !p.completed && p.position > 30 && p.duration - p.position > 90 ? p : null
}

function timeLeft (p: WatchProgress): string {
  const m = Math.max(1, Math.round((p.duration - p.position) / 60))
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`
}

function useSources (type: MediaType, streamId: string | null) {
  const [load, setLoad] = useState<Load<SourcesResponse> | null>(null)
  const [health, setHealth] = useState<HealthResponse>({})
  useEffect(() => {
    if (!streamId) return
    let live = true
    setLoad({ state: 'loading' })
    setHealth({})
    api.sources(type, streamId)
      .then(data => {
        if (!live) return
        setLoad({ state: 'ok', data })
        const hashes = data.sources.slice(0, 70).map(s => s.infoHash)
        if (hashes.length) api.swarm(hashes).then(h => { if (live) setHealth(h) }).catch(() => {})
      })
      .catch(err => { if (live) setLoad({ state: 'error', message: err.message }) })
    return () => { live = false }
  }, [type, streamId])
  return { load, health }
}

function EpisodePicker ({ episodes, seasonParam, selected, onSelect }: {
  episodes: Episode[]; seasonParam: string | null; selected: Episode | null; onSelect: (e: Episode) => void
}) {
  const seasons = useMemo(() => [...new Set(episodes.map(e => e.season))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b)), [episodes])
  const [season, setSeason] = useState<number>(() => Number(seasonParam) || selected?.season || seasons[0] || 1)
  const list = episodes.filter(e => e.season === season)
  const scroller = useRef<HTMLOListElement>(null)

  // Bring the selected episode into view within the shelf (horizontally only; the page doesn't jump).
  useLayoutEffect(() => {
    const el = scroller.current
    const active = el?.querySelector<HTMLElement>('.episode.active')
    if (!el) return
    if (!active) { el.scrollLeft = 0; return }
    const pad = parseFloat(getComputedStyle(el).scrollPaddingInlineStart) || 0
    el.scrollLeft = Math.max(0, active.parentElement!.offsetLeft - pad)
  }, [season, selected?.id])

  return (
    <section className="episodes" aria-labelledby="episodes-h">
      <div className="section-head">
        <h2 id="episodes-h" className="section-title">Episodes</h2>
        <div className="season-tabs" role="tablist" aria-label="Seasons">
          {seasons.map(s => (
            <button key={s} role="tab" aria-selected={s === season} className={s === season ? 'tab active' : 'tab'} onClick={() => {
              setSeason(s)
              history.replaceState(null, '', `${location.pathname}?season=${s}`)
            }}>
              {s === 0 ? 'Specials' : `Season ${s}`}
            </button>
          ))}
        </div>
      </div>
      <ol className="episode-list" ref={scroller}>
        {list.map(e => {
          const upcoming = e.released ? new Date(e.released) > new Date() : false
          const active = selected?.id === e.id
          return (
            <li key={e.id}>
              <button className={`episode${active ? ' active' : ''}`} onClick={() => onSelect(e)} disabled={upcoming} aria-pressed={active}>
                <EpisodeThumb src={e.thumbnail} />
                <span className="episode-text">
                  <span className="episode-name"><span className="episode-num">{e.episode}</span>{e.name}</span>
                  {upcoming
                    ? <span className="episode-overview">Airs {new Date(e.released!).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                    : e.overview && <span className="episode-overview">{e.overview}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function EpisodeThumb ({ src }: { src?: string }) {
  const [failed, setFailed] = useState(!src)
  const [loaded, onLoad] = useLoaded(src)
  return (
    <span className="episode-thumb">
      {!failed && <img src={src} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />}
    </span>
  )
}

function Backdrop ({ src }: { src?: string }) {
  const [loaded, onLoad] = useLoaded(src)
  if (!src) return null
  return <img className="hero-backdrop" src={src} alt="" decoding="async" fetchPriority="high" data-loaded={loaded || undefined} onLoad={onLoad} />
}

function bestLine (s: Source) {
  const parts = [s.release.resolution !== 'unknown' ? RES_LABEL[s.release.resolution] : null, s.release.source].filter(Boolean)
  return `${parts.length ? parts.join(' ') + ', ' : ''}${s.seeders ?? 0} seeders`
}

export function Title ({ type, id, season, play }: { type: MediaType; id: string; season: string | null; play: string | null }) {
  const [detail, setDetail] = useState<Load<TitleDetail>>({ state: 'loading' })
  const [episode, setEpisode] = useState<Episode | null>(null)
  const taste = useTitleState(type, id)
  const chosenFor = useRef<string | null>(null)
  const autoplayed = useRef(false)

  useEffect(() => {
    api.title(type, id)
      .then(data => setDetail({ state: 'ok', data }))
      .catch(err => setDetail({ state: 'error', message: err.message }))
  }, [type, id])

  // Choose the episode once the list and this profile's progress are both known, so the source search
  // runs once, for the right episode.
  useEffect(() => {
    if (type !== 'series' || detail.state !== 'ok' || !taste.ready) return
    const key = `${season}|${play}`
    if (chosenFor.current === key) return
    chosenFor.current = key
    setEpisode(initialEpisode(detail.data.episodes, { season, play, state: taste.state }))
  }, [type, detail, taste.ready, taste.state, season, play])

  const streamId = type === 'movie' ? id : episode?.id ?? null
  const { load, health } = useSources(type, streamId)
  useDocumentTitle(detail.state === 'ok' ? detail.data.name : undefined)

  // From Continue watching (?play=…): start the best source as soon as it is known, the way Play would.
  // The player replaces this entry, so Back returns to where the viewer came from.
  useEffect(() => {
    if (!play || autoplayed.current || detail.state !== 'ok' || !streamId || !load || load.state === 'loading') return
    autoplayed.current = true
    const best = load.state === 'ok' ? load.data.sources[0] : undefined
    if (best && streamId === play) {
      const t = detail.data
      const name = episode ? `${t.name} · S${episode.season}E${episode.episode} ${episode.name}` : t.name
      watchSource(best, { type, imdbId: id, streamId, name }, { replace: true })
    } else {
      history.replaceState(null, '', location.pathname)
      if (!best) toast('No sources found to resume this. Try again later or pick another episode.')
    }
  }, [play, detail, streamId, load, episode, type, id])

  if (detail.state === 'loading' || (type === 'series' && !episode && detail.state === 'ok' && detail.data.episodes.length > 0)) {
    return (
      <main className="title-page">
        <section className="hero is-pending"><TopBar /></section>
      </main>
    )
  }
  if (detail.state === 'error') {
    return (
      <main className="title-page">
        <TopBar solid />
        <div className="page-notice">
          <p className="empty-title">Couldn’t load this title</p>
          <p className="notice">{detail.message}</p>
        </div>
      </main>
    )
  }

  const t = detail.data
  const best = load?.state === 'ok' ? load.data.sources[0] : undefined
  const ctx = { type, imdbId: id, streamId: streamId ?? id, name: episode ? `${t.name} · S${episode.season}E${episode.episode} ${episode.name}` : t.name }
  const meta = [t.year, t.runtime, t.genres.slice(0, 3).join(', ')].filter(Boolean)
  const searching = load?.state === 'loading' || !load
  const resume = resumable(taste.state, streamId)
  const verb = resume ? 'Resume' : 'Play'

  return (
    <main className="title-page">
      <section className={`hero${t.background ? '' : ' no-art'}`}>
        <div className="hero-art">
          <Backdrop src={t.background} />
        </div>
        <div className="hero-shade" />
        <TopBar />
        <div className="hero-content">
          <TitleArt className="hero-logo" name={t.name} logo={t.logo} />
          <p className="meta-line">
            {meta.map((m, i) => <span key={i}>{m}</span>)}
            {t.imdbRating && <span className="rating"><span className="rating-label">IMDb</span> {t.imdbRating}</span>}
          </p>
          {t.description && <p className="hero-desc">{t.description}</p>}
          <div className="hero-actions actions">
            <button className="button primary" disabled={!best} aria-busy={searching || undefined} onClick={() => best && watchSource(best, ctx)}>
              {searching ? <span className="spinner" aria-hidden /> : <Play aria-hidden fill="currentColor" />}
              {searching ? 'Finding sources…' : best ? (episode ? `${verb} S${episode.season} E${episode.episode}` : verb) : 'No sources found'}
            </button>
            <TasteButtons actions={taste} name={t.name} />
          </div>
          {resume && (
            <p className="hero-progress">
              <span className="meter" aria-hidden><span style={{ width: `${Math.max(3, resume.fraction * 100)}%` }} /></span>
              {timeLeft(resume)}
            </p>
          )}
          {best && <p className="hero-best">Best source: {bestLine(best)}</p>}
          <DismissLine actions={taste} />
          {(t.cast.length > 0 || t.director.length > 0) && (
            <dl className="credits">
              {t.director.length > 0 && <div><dt>Director</dt><dd>{t.director.join(', ')}</dd></div>}
              {t.cast.length > 0 && <div><dt>Cast</dt><dd>{t.cast.slice(0, 5).join(', ')}</dd></div>}
            </dl>
          )}
        </div>
      </section>

      <div className="title-body">
        {type === 'series' && t.episodes.length > 0 && (
          <EpisodePicker episodes={t.episodes} seasonParam={season ?? (episode ? String(episode.season) : null)} selected={episode} onSelect={e => setEpisode(e)} />
        )}

        <section className="sources" aria-labelledby="sources-h">
          <div className="section-head">
            <h2 id="sources-h" className="section-title">
              Sources
              {episode && <span className="section-sub">S{episode.season} E{episode.episode} · {episode.name}</span>}
            </h2>
          </div>
          {searching && <div className="sources-loading"><span className="spinner" aria-hidden /> Searching torrent indexes…</div>}
          {load?.state === 'error' && <p className="notice">Couldn’t search for sources: {load.message}</p>}
          {load?.state === 'ok' && (
            <>
              {load.data.sources.length === 0
                ? (
                  <div className="empty">
                    <p className="empty-title">No torrents found for this {episode ? 'episode' : 'title'}</p>
                    <p className="notice">It may be too new or too obscure for the public indexes.</p>
                  </div>
                  )
                : <SourceList sources={load.data.sources} health={health} onPick={s => watchSource(s, ctx)} />}
              {Object.keys(load.data.errors).length > 0 && (
                <p className="fine-print">Some indexes didn’t answer: {Object.entries(load.data.errors).map(([k, v]) => `${k} (${v})`).join(', ')}</p>
              )}
            </>
          )}
        </section>
      </div>

      <MoreLikeThis type={type} id={id} />
    </main>
  )
}

/** "More like this", each with its reason. Hidden when there's nothing close enough. */
function MoreLikeThis ({ type, id }: { type: MediaType; id: string }) {
  const [items, setItems] = useState<RecItem[] | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  useEffect(() => {
    let live = true
    api.similar(type, id).then(r => { if (live) setItems(r.items) }).catch(() => { if (live) setItems([]) })
    return () => { live = false }
  }, [type, id])

  const notInterested = (it: RecItem) => {
    const show = (on: boolean) => setHidden(h => { const n = new Set(h); if (on) n.delete(it.id); else n.add(it.id); return n })
    show(false)
    api.dismiss(it.type, it.id, 'not_interested')
      .then(() => toast(`Not interested in ${it.name}. You’ll see less like it.`, {
        label: 'Undo',
        run: () => { show(true); api.undismiss(it.type, it.id).catch(() => {}) },
      }))
      .catch(err => { show(true); toast(`Couldn’t save that. ${(err as Error).message}`) })
  }

  const shown = items?.filter(it => !hidden.has(it.id))
  if (shown && shown.length === 0) return null
  return (
    <div className="title-more">
      <Row title="More like this" id="more-like-this">
        {shown
          ? shown.map(it => <RecCard key={it.id} item={it} onRemove={notInterested} />)
          : Array.from({ length: 8 }, (_, i) => <PosterSkeleton key={i} />)}
      </Row>
    </div>
  )
}
