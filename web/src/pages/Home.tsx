import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { TitleSummary } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { navigate } from '../router.ts'
import { PosterCard } from '../components/PosterCard.tsx'
import { Wordmark } from '../components/Wordmark.tsx'

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

function Row ({ title, load }: { title: string; load: Load<TitleSummary[]> }) {
  return (
    <section className="row">
      <h2 className="row-title">{title}</h2>
      {load.state === 'error' && <p className="muted">Couldn’t load: {load.message}</p>}
      <div className="row-scroller">
        {load.state === 'loading' && Array.from({ length: 8 }, (_, i) => <div key={i} className="poster-skeleton" />)}
        {load.state === 'ok' && load.data.slice(0, 20).map(t => <PosterCard key={t.id} title={t} />)}
      </div>
    </section>
  )
}

function usePopular (type: 'movie' | 'series'): Load<TitleSummary[]> {
  const [load, setLoad] = useState<Load<TitleSummary[]>>({ state: 'loading' })
  useEffect(() => {
    api.popular(type).then(data => setLoad({ state: 'ok', data })).catch(err => setLoad({ state: 'error', message: err.message }))
  }, [type])
  return load
}

export function Home ({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery)
  const results = useQueryResults(query)
  const movies = usePopular('movie')
  const series = usePopular('series')
  const input = useRef<HTMLInputElement>(null)

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
    <main className="home">
      <header className="home-header">
        <Wordmark />
        <form className="search" role="search" onSubmit={e => {
          e.preventDefault()
          const first = results?.state === 'ok' ? results.data[0] : undefined
          if (first) navigate(`/title/${first.type}/${first.id}`)
        }}>
          <Search className="search-icon" size={20} aria-hidden />
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search films and series"
            aria-label="Search films and series"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setQuery(''); input.current?.focus() }}>
              <X size={18} />
            </button>
          )}
        </form>
      </header>

      {results ? (
        <section className="results" aria-live="polite">
          {results.state === 'loading' && <div className="grid">{Array.from({ length: 12 }, (_, i) => <div key={i} className="poster-skeleton" />)}</div>}
          {results.state === 'error' && <p className="notice">Search failed: {results.message}</p>}
          {results.state === 'ok' && results.data.length === 0 && <p className="notice">Nothing found for “{query.trim()}”. Try the original title or fewer words.</p>}
          {results.state === 'ok' && results.data.length > 0 && (
            <div className="grid">{results.data.map(t => <PosterCard key={`${t.type}-${t.id}`} title={t} showType />)}</div>
          )}
        </section>
      ) : (
        <>
          <Row title="Popular films" load={movies} />
          <Row title="Popular series" load={series} />
        </>
      )}
    </main>
  )
}
