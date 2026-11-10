import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Play, Star } from 'lucide-react'
import type { Episode, HealthResponse, MediaType, Source, SourcesResponse, TitleDetail } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { navigate, onLinkClick } from '../router.ts'
import { SourceList } from '../components/SourceList.tsx'
import { Wordmark } from '../components/Wordmark.tsx'

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string }

/** Hands the chosen source to the player. Trackers ride in sessionStorage to keep the URL short. */
export function watchSource (s: Source, ctx: { type: MediaType; imdbId: string; streamId: string; name: string }) {
  try { sessionStorage.setItem(`nextup:trackers:${s.infoHash}`, JSON.stringify(s.trackers)) } catch { /* private mode */ }
  const q = new URLSearchParams({ ih: s.infoHash, type: ctx.type, id: ctx.imdbId, s: ctx.streamId, n: ctx.name })
  if (s.fileIdx !== undefined) q.set('f', String(s.fileIdx))
  if (s.fileName) q.set('fn', s.fileName)
  navigate(`/watch?${q}`)
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
  return (
    <section className="episodes">
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
      <ol className="episode-list">
        {list.map(e => {
          const upcoming = e.released ? new Date(e.released) > new Date() : false
          return (
            <li key={e.id}>
              <button className={`episode${selected?.id === e.id ? ' active' : ''}`} onClick={() => onSelect(e)} disabled={upcoming}>
                <div className="episode-thumb">
                  {e.thumbnail ? <img src={e.thumbnail} alt="" loading="lazy" /> : null}
                  <span className="episode-num">{e.episode}</span>
                </div>
                <div className="episode-text">
                  <span className="episode-name">{e.name}</span>
                  {upcoming
                    ? <span className="muted">Airs {new Date(e.released!).toLocaleDateString()}</span>
                    : e.overview && <span className="episode-overview">{e.overview}</span>}
                </div>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function Title ({ type, id, season }: { type: MediaType; id: string; season: string | null }) {
  const [detail, setDetail] = useState<Load<TitleDetail>>({ state: 'loading' })
  const [episode, setEpisode] = useState<Episode | null>(null)

  useEffect(() => {
    api.title(type, id)
      .then(data => {
        setDetail({ state: 'ok', data })
        if (type === 'series') {
          const s = Number(season)
          const first = data.episodes.find(e => (s ? e.season === s : e.season > 0)) ?? data.episodes[0]
          setEpisode(first ?? null)
        }
      })
      .catch(err => setDetail({ state: 'error', message: err.message }))
  }, [type, id, season])

  const streamId = type === 'movie' ? id : episode?.id ?? null
  const { load, health } = useSources(type, streamId)

  if (detail.state === 'loading') return <main className="title-page"><div className="hero hero-skeleton" /></main>
  if (detail.state === 'error') {
    return (
      <main className="title-page">
        <TopBar />
        <p className="notice">Couldn’t load this title: {detail.message}</p>
      </main>
    )
  }

  const t = detail.data
  const best = load?.state === 'ok' ? load.data.sources[0] : undefined
  const ctx = { type, imdbId: id, streamId: streamId ?? id, name: episode ? `${t.name} · S${episode.season}E${episode.episode} ${episode.name}` : t.name }
  const meta = [t.year, t.runtime, t.genres.slice(0, 3).join(', ')].filter(Boolean)

  return (
    <main className="title-page">
      <section className="hero">
        {t.background && <img className="hero-backdrop" src={t.background} alt="" />}
        <div className="hero-shade" />
        <TopBar />
        <div className="hero-content">
          {t.logo
            ? <h1 className="hero-logo"><img src={t.logo} alt={t.name} onError={e => { e.currentTarget.replaceWith(document.createTextNode(t.name)) }} /></h1>
            : <h1 className="hero-title">{t.name}</h1>}
          <p className="hero-meta">
            {meta.map((m, i) => <span key={i}>{m}</span>)}
            {t.imdbRating && <span className="rating"><Star size={14} aria-hidden /> {t.imdbRating}</span>}
          </p>
          {t.description && <p className="hero-desc">{t.description}</p>}
          <div className="hero-actions">
            <button className="button primary" disabled={!best} onClick={() => best && watchSource(best, ctx)}>
              <Play size={18} fill="currentColor" aria-hidden />
              {load?.state === 'loading' || !load ? 'Finding sources…' : best ? (episode ? `Play S${episode.season} E${episode.episode}` : 'Play') : 'No sources found'}
            </button>
            {best && <span className="hero-best">Best source: {best.release.resolution !== 'unknown' ? best.release.resolution : ''} {best.release.source ?? ''}, {best.seeders ?? 0} seeders</span>}
          </div>
          {(t.cast.length > 0 || t.director.length > 0) && (
            <dl className="credits">
              {t.director.length > 0 && <><dt>Director</dt><dd>{t.director.join(', ')}</dd></>}
              {t.cast.length > 0 && <><dt>Cast</dt><dd>{t.cast.slice(0, 5).join(', ')}</dd></>}
            </dl>
          )}
        </div>
      </section>

      <div className="title-body">
        {type === 'series' && t.episodes.length > 0 && (
          <EpisodePicker episodes={t.episodes} seasonParam={season} selected={episode} onSelect={e => setEpisode(e)} />
        )}

        <section className="sources" aria-labelledby="sources-h">
          <h2 id="sources-h" className="section-title">
            {episode ? <>Sources for <span className="muted">S{episode.season} E{episode.episode} · {episode.name}</span></> : 'Sources'}
          </h2>
          {(!load || load.state === 'loading') && <div className="sources-loading"><span className="spinner" aria-hidden /> Searching torrent indexes…</div>}
          {load?.state === 'error' && <p className="notice">Couldn’t search for sources: {load.message}</p>}
          {load?.state === 'ok' && (
            <>
              {Object.keys(load.data.errors).length > 0 && (
                <p className="muted small">Some indexes didn’t answer: {Object.entries(load.data.errors).map(([k, v]) => `${k} (${v})`).join(', ')}</p>
              )}
              {load.data.sources.length === 0
                ? <p className="notice">No torrents found for this {episode ? 'episode' : 'title'}. It may be too new or too obscure for the public indexes.</p>
                : <SourceList sources={load.data.sources} health={health} onPick={s => watchSource(s, ctx)} />}
            </>
          )}
        </section>
      </div>
    </main>
  )
}

function TopBar () {
  return (
    <nav className="topbar">
      <a href="/" onClick={e => { if (history.length > 1 && document.referrer.startsWith(location.origin)) { e.preventDefault(); history.back() } else onLinkClick(e) }} className="icon-button" aria-label="Back">
        <ArrowLeft size={22} />
      </a>
      <Wordmark />
    </nav>
  )
}
