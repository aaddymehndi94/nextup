import { useEffect, useRef, useState } from 'react'
import { Info, Search, X } from 'lucide-react'
import type { TitleDetail, TitleSummary } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useDocumentTitle, useLoaded, useScrolled } from '../hooks.ts'
import { navigate, onLinkClick } from '../router.ts'
import { PosterCard, PosterSkeleton } from '../components/PosterCard.tsx'
import { Row } from '../components/Row.tsx'
import { TitleArt } from '../components/TitleArt.tsx'
import { Wordmark } from '../components/Wordmark.tsx'
import { Downloads } from '../components/Downloads.tsx'

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string }

function useQueryResults (query: string): Load<TitleSummary[]> | null {
  const [result, setResult] = useState<Load<TitleSummary[]> | null>(null)
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResult(null); return }
    setResult(prev => (prev?.state === 'ok' ? prev : { state: 'loading' }))
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      api.search(q, ctrl.signal)
        .then(data => setResult({ state: 'ok', data }))
        .catch(err => { if (!ctrl.signal.aborted) setResult({ state: 'error', message: err.message }) })
    }, 220)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [query])
  return result
}

function PopularRow ({ title, load }: { title: string; load: Load<TitleSummary[]> }) {
  return (
    <Row title={title}>
      {load.state === 'error' && <p className="row-notice">Couldn’t load: {load.message}</p>}
      {load.state === 'loading' && Array.from({ length: 10 }, (_, i) => <PosterSkeleton key={i} />)}
      {load.state === 'ok' && load.data.slice(0, 20).map(t => <PosterCard key={t.id} title={t} />)}
    </Row>
  )
}

function usePopular (type: 'movie' | 'series'): Load<TitleSummary[]> {
  const [load, setLoad] = useState<Load<TitleSummary[]>>({ state: 'loading' })
  useEffect(() => {
    api.popular(type).then(data => setLoad({ state: 'ok', data })).catch(err => setLoad({ state: 'error', message: err.message }))
  }, [type])
  return load
}

/** The most popular film, presented full-bleed. Falls back to nothing when its artwork is missing. */
function Billboard ({ load }: { load: Load<TitleSummary[]> }) {
  const first = load.state === 'ok' ? load.data[0] : undefined
  const [detail, setDetail] = useState<TitleDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [loaded, onLoad] = useLoaded(detail?.background)

  useEffect(() => {
    if (!first) return
    let live = true
    api.title(first.type, first.id)
      .then(d => { if (live) setDetail(d) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [first?.type, first?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (load.state === 'error' || (load.state === 'ok' && !first) || failed || (detail && !detail.background)) {
    return <div className="masthead-spacer" />
  }
  if (!detail) return <section className="billboard pending" aria-hidden />

  const t = detail
  const href = `/title/${t.type}/${t.id}`
  const meta = [t.year, t.runtime, t.genres.slice(0, 2).join(', ')].filter(Boolean)
  return (
    <section className="billboard" aria-label="Most popular film">
      <picture className="billboard-art">
        {t.poster && <source media="(max-width: 640px)" srcSet={t.poster} />}
        <img src={t.background} alt="" decoding="async" fetchPriority="high" data-loaded={loaded || undefined} onLoad={onLoad} />
      </picture>
      <div className="billboard-shade" />
      <div className="billboard-content">
        <TitleArt as="h2" className="billboard-logo" name={t.name} logo={t.logo} />
        <p className="meta-line">
          <span className="meta-strong">Most popular film</span>
          {meta.map((m, i) => <span key={i}>{m}</span>)}
        </p>
        {t.description && <p className="billboard-desc">{t.description}</p>}
        <div className="actions">
          <a className="button primary" href={href} onClick={onLinkClick}>
            <Info aria-hidden />
            More info
          </a>
        </div>
      </div>
    </section>
  )
}

// Focus search on load only with a mouse: on a phone it would raise the keyboard over the billboard, and on a
// TV it would trap the remote's arrow keys inside the input.
const FINE_POINTER = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches

export function Home ({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery)
  const results = useQueryResults(query)
  const movies = usePopular('movie')
  const series = usePopular('series')
  const input = useRef<HTMLInputElement>(null)
  const scrolled = useScrolled()
  const q = query.trim()
  useDocumentTitle(q ? `Results for “${q}”` : undefined)

  // Keep the query in the URL so Back from a title returns to the same results.
  useEffect(() => {
    const t = setTimeout(() => {
      const url = query.trim() ? `/?q=${encodeURIComponent(query.trim())}` : '/'
      if (url !== location.pathname + location.search) history.replaceState(null, '', url)
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== input.current) { e.preventDefault(); input.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <main className={`home${results ? ' is-searching' : ''}`}>
      <h1 className="sr-only">nexttupp</h1>
      <header className={`masthead${scrolled || results ? ' is-solid' : ''}`}>
        <Wordmark />
        <form className="search" role="search" onSubmit={e => {
          e.preventDefault()
          const first = results?.state === 'ok' ? results.data[0] : undefined
          if (first) navigate(`/title/${first.type}/${first.id}`)
        }}>
          <Search className="search-icon" aria-hidden />
          <input
            ref={input}
            autoFocus={FINE_POINTER}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search films and series"
            aria-label="Search films and series"
            enterKeyHint="search"
            spellCheck={false}
          />
          {query
            ? (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery(''); input.current?.focus() }}>
                <X aria-hidden />
              </button>
              )
            : <kbd className="search-hint" aria-hidden>/</kbd>}
        </form>
      </header>

      {results ? (
        <section className="results" aria-live="polite">
          {results.state === 'ok' && results.data.length > 0 && (
            <h2 className="page-heading">Results for <span className="quiet">“{q}”</span></h2>
          )}
          {results.state === 'loading' && <div className="grid">{Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} />)}</div>}
          {results.state === 'error' && <p className="notice">Search failed: {results.message}</p>}
          {results.state === 'ok' && results.data.length === 0 && (
            <div className="empty">
              <p className="empty-title">Nothing found for “{q}”</p>
              <p className="notice">Try the original title, or fewer words.</p>
            </div>
          )}
          {results.state === 'ok' && results.data.length > 0 && (
            <div className="grid">{results.data.map(t => <PosterCard key={`${t.type}-${t.id}`} title={t} showType />)}</div>
          )}
        </section>
      ) : (
        <>
          <Billboard load={movies} />
          <div className="shelves">
            <Downloads />
            <PopularRow title="Popular films" load={movies} />
            <PopularRow title="Popular series" load={series} />
          </div>
        </>
      )}
    </main>
  )
}
