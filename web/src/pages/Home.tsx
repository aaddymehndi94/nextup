import { useCallback, useEffect, useRef, useState } from 'react'
import { Info, Search, SlidersHorizontal, X } from 'lucide-react'
import type { HomeResponse, HomeRow, MediaType, OnboardingResponse, Rating, RecItem, TitleDetail, TitleSummary } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useDocumentTitle, useLoaded, useScrolled } from '../hooks.ts'
import { navigate, onLinkClick } from '../router.ts'
import { EMPTY_STATE, useTitleState } from '../taste.ts'
import { toast } from '../toast.ts'
import { PosterCard, PosterSkeleton } from '../components/PosterCard.tsx'
import { ContinueCard, RateCard, RecCard } from '../components/RecCard.tsx'
import { Row } from '../components/Row.tsx'
import { TasteButtons } from '../components/TitleActions.tsx'
import { TitleArt } from '../components/TitleArt.tsx'
import { Wordmark } from '../components/Wordmark.tsx'
import { Downloads } from '../components/Downloads.tsx'
import { ProfileMenu } from '../components/ProfileMenu.tsx'

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

// ---- The personalised feed -------------------------------------------------------------------

/** While the server is still filling in (warming), ask again this often, this many times at most. */
const WARM_RETRY_MS = 4000
const WARM_RETRIES = 8

function useHomeFeed (tab?: MediaType) {
  const [load, setLoad] = useState<Load<HomeResponse>>({ state: 'loading' })
  const retries = useRef(0)
  const generation = useRef(0)

  /** Fetches the feed. The rows on screen stay until the new ones arrive, so nothing flashes or jumps. */
  const refresh = useCallback(() => {
    const mine = ++generation.current
    return api.home(tab)
      .then(data => { if (generation.current === mine) setLoad({ state: 'ok', data }) })
      .catch(err => { if (generation.current === mine) setLoad(prev => (prev.state === 'ok' ? prev : { state: 'error', message: err.message })) })
  }, [tab])

  useEffect(() => { void refresh() }, [refresh])

  const warming = load.state === 'ok' && load.data.warming
  useEffect(() => {
    if (!warming || retries.current >= WARM_RETRIES || document.hidden) return
    const t = setTimeout(() => { retries.current++; void refresh() }, WARM_RETRY_MS)
    return () => clearTimeout(t)
  }, [warming, load, refresh])

  const restart = useCallback(() => { retries.current = 0; return refresh() }, [refresh])
  return { load, refresh: restart }
}

const isRecRow = (row: HomeRow) => !['continue', 'list', 'onboarding'].includes(row.kind)

/** The billboard's title: the top pick once picks are personal, otherwise the most popular film. */
function billboardOf (data: HomeResponse): { item: RecItem; label: string; rowId: string } | null {
  const row = data.coldStart ? data.rows.find(r => r.id.startsWith('popular:')) : data.rows.find(r => r.kind === 'top')
  const item = row?.items.find(i => i.background)
  if (!row || !item) return null
  return { item, label: data.coldStart ? 'Popular now' : item.reason.text, rowId: row.id }
}

function Feed ({ tab }: { tab?: MediaType }) {
  const { load, refresh } = useHomeFeed(tab)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  // The billboard stays put while rows refresh underneath it.
  const pinned = useRef<{ cold: boolean; pick: ReturnType<typeof billboardOf> } | null>(null)

  const hide = useCallback((id: string, on: boolean) => setHidden(h => {
    const n = new Set(h)
    if (on) n.add(id); else n.delete(id)
    return n
  }), [])

  const notInterested = useCallback((it: RecItem) => {
    hide(it.id, true)
    api.dismiss(it.type, it.id, 'not_interested')
      .then(() => toast(`Not interested in ${it.name}. You’ll see less like it.`, {
        label: 'Undo',
        run: () => { hide(it.id, false); api.undismiss(it.type, it.id).catch(() => {}) },
      }))
      .catch(err => { hide(it.id, false); toast(`Couldn’t save that. ${(err as Error).message}`) })
  }, [hide])

  const removeFromList = useCallback((it: RecItem) => {
    hide(`list:${it.id}`, true)
    api.removeFromList(it.type, it.id)
      .then(() => toast(`Removed ${it.name} from My List.`, {
        label: 'Undo',
        run: () => { hide(`list:${it.id}`, false); api.addToList(it.type, it.id).catch(() => {}) },
      }))
      .catch(err => { hide(`list:${it.id}`, false); toast(`Couldn’t remove that. ${(err as Error).message}`) })
  }, [hide])

  const removeFromContinue = useCallback((it: RecItem) => {
    hide(`continue:${it.id}`, true)
    api.clearProgress(it.type, it.id)
      .then(() => toast(`Removed ${it.name} from Continue watching. Your place is kept if you play it again.`))
      .catch(err => { hide(`continue:${it.id}`, false); toast(`Couldn’t remove that. ${(err as Error).message}`) })
  }, [hide])

  if (load.state === 'error') return <FallbackFeed />
  if (load.state === 'loading') {
    return (
      <>
        <section className="billboard pending" aria-hidden />
        <div className="shelves">
          {!tab && <Downloads />}
          {[0, 1].map(i => (
            <Row key={i} title={tab === 'series' || (!tab && i) ? 'Popular series' : 'Popular films'} id={`row-loading-${i}`}>
              {Array.from({ length: 10 }, (_, j) => <PosterSkeleton key={j} />)}
            </Row>
          ))}
        </div>
      </>
    )
  }

  const data = load.data
  if (!pinned.current || pinned.current.cold !== data.coldStart || (pinned.current.pick && hidden.has(pinned.current.pick.item.id))) {
    pinned.current = { cold: data.coldStart, pick: billboardOf({ ...data, rows: data.rows.map(r => ({ ...r, items: r.items.filter(i => !hidden.has(i.id)) })) }) }
  }
  const pick = pinned.current.pick

  const rows = data.rows.map(row => {
    const items = row.items.filter(it => {
      if (row.kind === 'list') return !hidden.has(`list:${it.id}`)
      if (row.kind === 'continue') return !hidden.has(`continue:${it.id}`)
      // The billboard's title isn't repeated just below it.
      return !hidden.has(it.id) && !(pick && it.id === pick.item.id && row.id === pick.rowId)
    })
    return { ...row, items }
  }).filter(row => row.items.length > 0 || row.kind === 'onboarding')

  // Downloads sit after what the viewer is in the middle of (or, for a new profile, after rating a few).
  const anchor = rows.find(r => r.kind === 'continue') ?? rows.find(r => r.kind === 'onboarding')
  const shelves: React.ReactNode[] = []
  if (!anchor && !tab) shelves.push(<Downloads key="downloads" />)
  for (const row of rows) {
    if (row.kind === 'continue') {
      shelves.push(
        <Row key={row.id} title={row.title} variant="landscape" id="row-continue" className="row-continue">
          {row.items.map(it => <ContinueCard key={it.id} item={it} onRemove={removeFromContinue} />)}
        </Row>,
      )
    } else if (row.kind === 'onboarding') {
      shelves.push(<Onboarding key={row.id} row={row} onReady={refresh} />)
    } else if (row.kind === 'list') {
      shelves.push(
        <Row key={row.id} title={row.title} id="row-my-list" className="row-list">
          {row.items.map(it => <RecCard key={it.id} item={it} onRemove={removeFromList} removeLabel="Remove from My List" />)}
        </Row>,
      )
    } else {
      shelves.push(
        <Row
          key={row.id}
          title={row.title}
          caption={row.subtitle}
          id={`row-${row.id.replace(/\W+/g, '-')}`}
          className={`row-rec row-kind-${row.kind}`}
          aside={row.kind === 'top' ? <a className="row-link" href="/taste" onClick={onLinkClick}><SlidersHorizontal aria-hidden />Why these?</a> : undefined}
        >
          {row.items.map(it => <RecCard key={it.id} item={it} onRemove={isRecRow(row) ? notInterested : undefined} />)}
        </Row>,
      )
    }
    if (row === anchor && !tab) shelves.push(<Downloads key="downloads" />)
  }

  return (
    <>
      {pick ? <PickBillboard item={pick.item} label={pick.label} /> : <div className="masthead-spacer" />}
      <div className="shelves">{shelves}</div>
    </>
  )
}

/** The featured title, full-bleed: the top pick with its reason, or the most popular film before that. */
function PickBillboard ({ item: t, label }: { item: RecItem; label: string }) {
  const [loaded, onLoad] = useLoaded(t.background)
  const taste = useTitleState(t.type, t.id, { initial: EMPTY_STATE, source: 'billboard' })
  const href = `/title/${t.type}/${t.id}`
  const meta = [t.year, t.runtime, t.genres.slice(0, 2).join(', ')].filter(Boolean)
  return (
    <section className="billboard" aria-label={label === 'Popular now' ? 'Popular now' : 'Top pick for you'}>
      <picture className="billboard-art">
        {t.poster && <source media="(max-width: 640px)" srcSet={t.poster} />}
        <img src={t.background} alt="" decoding="async" fetchPriority="high" data-loaded={loaded || undefined} onLoad={onLoad} />
      </picture>
      <div className="billboard-shade" />
      <div className="billboard-content">
        <TitleArt as="h2" className="billboard-logo" name={t.name} logo={t.logo} />
        <p className="meta-line">
          <span className="meta-strong">{label}</span>
          {meta.map((m, i) => <span key={i}>{m}</span>)}
        </p>
        {t.description && <p className="billboard-desc">{t.description}</p>}
        <div className="actions">
          <a className="button primary" href={href} onClick={onLinkClick}>
            <Info aria-hidden />
            More info
          </a>
          <TasteButtons actions={taste} name={t.name} listOnly />
        </div>
      </div>
    </section>
  )
}

// ---- Cold start: rate a few -----------------------------------------------------------------

/**
 * "Rate a few to get started": well-known, varied titles with Like and Dislike right on the card, and a
 * meter towards the likes needed. Reaching it rebuilds the home screen around those likes.
 */
function Onboarding ({ row, onReady }: { row: HomeRow; onReady: () => Promise<unknown> }) {
  const [data, setData] = useState<OnboardingResponse | null>(null)
  const [ratings, setRatings] = useState<Map<string, Rating>>(() => new Map())
  const [positives, setPositives] = useState<number | null>(null)
  const [building, setBuilding] = useState(false)
  const target = data?.target ?? 3
  // The latest count, for the async callbacks below: quick taps never read a stale one.
  const latest = useRef({ positives: 0, building: false })
  latest.current.positives = positives ?? 0

  useEffect(() => {
    let on = true
    api.onboarding().then(d => {
      if (!on) return
      setData(d)
      setPositives(p => p ?? d.positives ?? 0)
    }).catch(() => {})
    return () => { on = false }
  }, [])

  // Keep the order steady while rating: titles already shown stay where they are.
  const items = data ? mergeKeepingOrder(row.items, data.items) : row.items
  const count = positives ?? 0

  const rate = (it: RecItem, value: Rating) => {
    const before = ratings.get(it.id) ?? 0
    const delta = (value === 1 ? 1 : 0) - (before === 1 ? 1 : 0)
    setRatings(m => new Map(m).set(it.id, value))
    setPositives(p => (p ?? 0) + delta)
    api.rate(it.type, it.id, value, 'onboarding').then(() => {
      if (delta > 0 && latest.current.positives >= target && !latest.current.building) {
        latest.current.building = true
        setBuilding(true)
        // A beat to see the meter fill, then the picks.
        setTimeout(() => { void onReady() }, 900)
      }
    }).catch(err => {
      setRatings(m => new Map(m).set(it.id, before))
      setPositives(p => (p ?? 0) - delta)
      toast(`Couldn’t save that rating. ${(err as Error).message}`)
    })
  }

  const left = Math.max(0, target - count)
  const caption = building
    ? 'That’s enough to go on. Building your picks…'
    : left === target
      ? `Like ${target} you enjoyed, and dislike any you didn’t. Your picks start from there.`
      : left > 0
        ? `Like ${left} more and picks will start to follow your taste.`
        : 'Rate as many as you like.'

  return (
    <Row
      title={row.title}
      caption={<span aria-live="polite">{caption}</span>}
      id="row-onboarding"
      className="row-onboarding"
      aside={(
        <span className="meter-group" role="progressbar" aria-label="Likes so far" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(count, target)}>
          <span className="segments" aria-hidden>
            {Array.from({ length: target }, (_, i) => <span key={i} className={i < count ? 'on' : undefined} />)}
          </span>
          <span className="meter-text">{Math.min(count, target)} of {target} likes</span>
        </span>
      )}
    >
      {items.map(it => <RateCard key={it.id} item={it} rating={ratings.get(it.id) ?? 0} onRate={rate} />)}
    </Row>
  )
}

function mergeKeepingOrder (first: RecItem[], more: RecItem[]): RecItem[] {
  const seen = new Set(first.map(i => i.id))
  return [...first, ...more.filter(i => !seen.has(i.id))]
}

// ---- When the recommender can't answer: the plain popular rows ----------------------------

function usePopular (type: 'movie' | 'series'): Load<TitleSummary[]> {
  const [load, setLoad] = useState<Load<TitleSummary[]>>({ state: 'loading' })
  useEffect(() => {
    api.popular(type).then(data => setLoad({ state: 'ok', data })).catch(err => setLoad({ state: 'error', message: err.message }))
  }, [type])
  return load
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

function FallbackFeed () {
  const movies = usePopular('movie')
  const series = usePopular('series')
  return (
    <>
      <PopularBillboard load={movies} />
      <div className="shelves">
        <Downloads />
        <PopularRow title="Popular films" load={movies} />
        <PopularRow title="Popular series" load={series} />
      </div>
    </>
  )
}

/** The most popular film, presented full-bleed. Falls back to nothing when its artwork is missing. */
function PopularBillboard ({ load }: { load: Load<TitleSummary[]> }) {
  const first = load.state === 'ok' ? load.data[0] : undefined
  const [detail, setDetail] = useState<TitleDetail | null>(null)
  const [failed, setFailed] = useState(false)

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
  const item: RecItem = { ...detail, imdbRating: detail.imdbRating, reason: { kind: 'popular', text: 'Most popular film' } }
  return <PickBillboard item={item} label="Most popular film" />
}

// ---- Page ------------------------------------------------------------------------------------

// Focus search on load only with a mouse: on a phone it would raise the keyboard over the billboard, and on a
// TV it would trap the remote's arrow keys inside the input.
const FINE_POINTER = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches

const TABS: Array<{ href: string; label: string; tab?: MediaType }> = [
  { href: '/', label: 'Home' },
  { href: '/films', label: 'Films', tab: 'movie' },
  { href: '/series', label: 'Series', tab: 'series' },
]

/** Home (films and series together), or the Films or Series tab: the same page, one kind of title. */
export function Home ({ initialQuery, tab }: { initialQuery: string; tab?: MediaType }) {
  const base = TABS.find(t => t.tab === tab)?.href ?? '/'
  const [query, setQuery] = useState(initialQuery)
  const results = useQueryResults(query)
  const input = useRef<HTMLInputElement>(null)
  const scrolled = useScrolled()
  const q = query.trim()
  useDocumentTitle(q ? `Results for “${q}”` : tab ? TABS.find(t => t.tab === tab)?.label : undefined)

  // Keep the query in the URL so Back from a title returns to the same results.
  useEffect(() => {
    const t = setTimeout(() => {
      const url = query.trim() ? `${base}?q=${encodeURIComponent(query.trim())}` : base
      if (url !== location.pathname + location.search) history.replaceState(null, '', url)
    }, 300)
    return () => clearTimeout(t)
  }, [query, base])

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
        <div className="masthead-start">
          <Wordmark />
          <nav className="tabs" aria-label="Browse">
            {TABS.map(t => (
              <a key={t.href} href={t.href} onClick={e => { setQuery(''); onLinkClick(e) }} aria-current={t.tab === tab ? 'page' : undefined}>{t.label}</a>
            ))}
          </nav>
        </div>
        <div className="masthead-end">
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
          <ProfileMenu />
        </div>
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
      ) : <Feed key={tab ?? 'all'} tab={tab} />}
    </main>
  )
}
