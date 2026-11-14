import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Clapperboard, Info, RefreshCw, Search, SlidersHorizontal, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import type { AiPicksResponse, AiSearchResponse, HomeResponse, HomeRow, MediaType, OnboardingResponse, Rating, RecItem, TitleDetail, TitleSummary } from '../../../shared/types.ts'
import { api, getActiveProfile } from '../api.ts'
import { chooseFeatured, featuredLately, markFeatured } from '../billboard.ts'
import { useDocumentTitle, useLoaded, usePageActive, useScrolled } from '../hooks.ts'
import { navigate, onLinkClick, replaceUrl } from '../router.ts'
import { usePrivate } from '../private.ts'
import { noteSource } from '../storage.ts'
import { EMPTY_STATE, useTitleState } from '../taste.ts'
import { toast } from '../toast.ts'
import { PosterSkeleton } from '../components/PosterCard.tsx'
import { TitleCard } from '../components/TitleCard.tsx'
import { noteMark, setTitleInList } from '../marks.ts'
import { ContinueCard, RateCard, RecCard } from '../components/RecCard.tsx'
import { Row } from '../components/Row.tsx'
import { TasteButtons } from '../components/TitleActions.tsx'
import { TitleArt } from '../components/TitleArt.tsx'
import { TrailerButton, TrailerVideo, useTrailer } from '../components/Trailer.tsx'
import { showPreview } from '../components/Preview.tsx'
import { Wordmark } from '../components/Wordmark.tsx'
import { BrowseTabs, TABS } from '../components/BrowseTabs.tsx'
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

  // Back on this page after a title or a film (it was kept alive): Continue watching and My List may have
  // changed. Only those rows are swapped, so the picks stay where the viewer left them.
  const active = usePageActive()
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) {
      api.home(tab)
        .then(fresh => setLoad(prev => (prev.state === 'ok' ? { state: 'ok', data: withPersonalRows(prev.data, fresh) } : prev)))
        .catch(() => {})
    }
    wasActive.current = active
  }, [active, tab])

  const warming = load.state === 'ok' && load.data.warming
  useEffect(() => {
    if (!warming || retries.current >= WARM_RETRIES || document.hidden) return
    const t = setTimeout(() => { retries.current++; void refresh() }, WARM_RETRY_MS)
    return () => clearTimeout(t)
  }, [warming, load, refresh])

  const restart = useCallback(() => { retries.current = 0; return refresh() }, [refresh])
  return { load, refresh: restart }
}

const isPersonalRow = (row: HomeRow) => row.kind === 'continue' || row.kind === 'list'

/** `now` with its Continue watching and My List rows as they are in `fresh`; every other row stays. */
function withPersonalRows (now: HomeResponse, fresh: HomeResponse): HomeResponse {
  const latest = new Map(fresh.rows.filter(isPersonalRow).map(r => [r.kind, r]))
  const rows = now.rows.flatMap(r => (!isPersonalRow(r) ? [r] : latest.has(r.kind) ? [latest.get(r.kind)!] : []))
  fresh.rows.forEach((r, i) => {
    if (isPersonalRow(r) && !rows.some(x => x.kind === r.kind)) rows.splice(Math.min(i, rows.length), 0, r)
  })
  return { ...now, rows }
}

const isRecRow = (row: HomeRow) => !['continue', 'list', 'onboarding'].includes(row.kind)

/** Rows that can go on: more titles load when one is scrolled near its end. */
const ROW_LIMIT = 120

/**
 * Endless scrolling. Rows below the first screen load a few at a time as the viewer nears the bottom, and a
 * row scrolled near its end gets more titles in the same spirit, until the server has no more.
 */
function useFeedPaging (tab: MediaType | undefined, data: HomeResponse | null) {
  const [extra, setExtra] = useState<HomeRow[]>([])
  const [more, setMore] = useState(false)
  const [added, setAdded] = useState<Map<string, RecItem[]>>(() => new Map())
  const next = useRef<number | null>(null)
  const busy = useRef(false)
  const rowBusy = useRef(new Set<string>())
  const rowDone = useRef(new Set<string>())

  useEffect(() => {
    if (!data || next.current !== null) return
    next.current = data.rows.length
    setMore(Boolean(data.more))
  }, [data])

  const loadPage = useCallback(() => {
    const from = next.current
    if (busy.current || from === null || !more) return
    busy.current = true
    api.homeMore(from, tab)
      .then(r => {
        next.current = from + r.rows.length
        setExtra(prev => [...prev, ...r.rows])
        setMore(r.more && r.rows.length > 0)
      })
      .catch(() => setMore(false))
      .finally(() => { busy.current = false })
  }, [tab, more])

  const extendRow = useCallback((rowId: string, have: string[]) => {
    if (rowBusy.current.has(rowId) || rowDone.current.has(rowId) || have.length >= ROW_LIMIT) return
    rowBusy.current.add(rowId)
    api.rowMore(rowId, have, tab)
      .then(items => {
        const known = new Set(have)
        const fresh = items.filter(it => !known.has(it.id))
        if (!fresh.length) { rowDone.current.add(rowId); return }
        setAdded(prev => new Map(prev).set(rowId, [...(prev.get(rowId) ?? []), ...fresh]))
      })
      .catch(() => rowDone.current.add(rowId))
      .finally(() => rowBusy.current.delete(rowId))
  }, [tab])

  return { extra, more, loadPage, added, extendRow }
}

/** Calls `onVisible` while the element is within ~1.5 screens of the viewport (again after each load, if still near). */
function useNearBottom (onVisible: () => void, active: boolean, deps: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const shown = usePageActive()
  useEffect(() => {
    const el = ref.current
    if (!el || !active || !shown) return
    const near = () => el.getBoundingClientRect().top < window.innerHeight * 2.5
    if (near()) onVisible()
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) onVisible() }, { rootMargin: '0px 0px 150% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [onVisible, active, deps, shown])
  return ref
}

/**
 * The billboard's title: one of the top picks once picks are personal, otherwise of the most popular films. They
 * take turns (billboard.ts), so Home doesn't open on the same film every time. Chosen once per visit to Home.
 */
function billboardOf (data: HomeResponse): { item: RecItem; label: string; rowId: string } | null {
  const row = data.coldStart ? data.rows.find(r => r.id.startsWith('popular:')) : data.rows.find(r => r.kind === 'top')
  const profile = getActiveProfile()
  const item = row && chooseFeatured(row.items.filter(i => i.background), featuredLately(profile))
  if (!row || !item) return null
  markFeatured(profile, item.id)
  return { item, label: data.coldStart ? 'Popular now' : item.reason.text, rowId: row.id }
}

function Feed ({ tab, ai, onAi }: { tab?: MediaType; ai: AiPicksResponse | null; onAi: (a: AiPicksResponse) => void }) {
  const { load, refresh } = useHomeFeed(tab)
  const paging = useFeedPaging(tab, load.state === 'ok' ? load.data : null)
  const bottom = useNearBottom(paging.loadPage, paging.more, paging.extra.length)
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
      .then(s => {
        noteMark(it.id, s)
        toast(`Removed ${it.name} from My List.`, {
          label: 'Undo',
          run: () => { hide(`list:${it.id}`, false); setTitleInList(it.type, it.id, true) },
        })
      })
      .catch(err => { hide(`list:${it.id}`, false); toast(`Couldn’t remove that. ${(err as Error).message}`) })
  }, [hide])

  const removeFromContinue = useCallback((it: RecItem) => {
    hide(`continue:${it.id}`, true)
    api.clearProgress(it.type, it.id)
      .then(() => toast(`Removed ${it.name} from Continue watching. Your place is kept if you play it again.`))
      .catch(err => { hide(`continue:${it.id}`, false); toast(`Couldn’t remove that. ${(err as Error).message}`) })
  }, [hide])

  /** A discover row's question: more of this kind of title, or none of it. */
  const answer = useCallback((row: HomeRow, value: 1 | -1) => {
    const f = row.feature
    if (!f) return
    hide(value === 1 ? `asked:${row.id}` : `row:${row.id}`, true)
    const undo = () => { hide(`asked:${row.id}`, false); hide(`row:${row.id}`, false) }
    api.setFeaturePref(f.key, value)
      .then(() => toast(value === 1 ? `Noted. More “${row.title}” in your picks.` : `Noted. No more “${row.title}” in your picks.`, {
        label: 'Undo',
        run: () => { undo(); api.setFeaturePref(f.key, 0).catch(() => {}) },
      }))
      .catch(err => { undo(); toast(`Couldn’t save that. ${(err as Error).message}`) })
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

  const seenRows = new Set<string>()
  const rows = [...data.rows, ...paging.extra].filter(row => {
    if (seenRows.has(row.id) || hidden.has(`row:${row.id}`)) return false
    seenRows.add(row.id)
    return true
  }).map(row => {
    const more = paging.added.get(row.id)
    const all = more ? [...row.items, ...more.filter(m => !row.items.some(it => it.id === m.id))] : row.items
    const items = all.filter(it => {
      if (row.kind === 'list') return !hidden.has(`list:${it.id}`)
      if (row.kind === 'continue') return !hidden.has(`continue:${it.id}`)
      // The billboard's title isn't repeated just below it.
      return !hidden.has(it.id) && !(pick && it.id === pick.item.id && row.id === pick.rowId)
    })
    return { ...row, items, have: all.map(it => it.id) }
  }).filter(row => row.items.length > 0 || row.kind === 'onboarding')

  // Downloads sit after what the viewer is in the middle of (or, for a new profile, after rating a few).
  const anchor = rows.find(r => r.kind === 'continue') ?? rows.find(r => r.kind === 'onboarding')
  const shelves: React.ReactNode[] = []
  if (!anchor && !tab) shelves.push(<Downloads key="downloads" />)
  // AI picks go just below Top picks (or the first row of picks on a new profile), and only once.
  const aiAfter = rows.find(r => r.kind === 'top') ?? rows.find(r => isRecRow(r))
  const aiRow = <AiPicksRow key="ai" ai={ai} onAi={onAi} tab={tab} hidden={hidden} onRemove={notInterested} />
  for (const row of rows) {
    if (row.kind === 'continue') {
      shelves.push(
        <Row key={row.id} title={row.title} variant="landscape" id="row-continue" className="row-continue" source="continue">
          {row.items.map(it => <ContinueCard key={it.id} item={it} onRemove={removeFromContinue} />)}
        </Row>,
      )
    } else if (row.kind === 'onboarding') {
      shelves.push(<Onboarding key={row.id} row={row} onReady={refresh} />)
    } else if (row.kind === 'list') {
      shelves.push(
        <Row key={row.id} title={row.title} id="row-my-list" className="row-list" source="list"
          aside={<a className="row-link" href="/list" onClick={onLinkClick}>See all<ChevronRight aria-hidden /></a>}>
          {row.items.map(it => <RecCard key={it.id} item={it} onRemove={removeFromList} removeLabel="Remove from My List" listed />)}
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
          source={row.id}
          aside={row.kind === 'top'
            ? <a className="row-link" href="/taste" onClick={onLinkClick}><SlidersHorizontal aria-hidden />Why these?</a>
            : row.kind === 'discover' && row.feature
              ? hidden.has(`asked:${row.id}`)
                ? <span className="row-link done"><Check aria-hidden />More like this</span>
                : (
                  <span className="discover-answer">
                    <button type="button" className="row-link" onClick={() => answer(row, 1)}><ThumbsUp aria-hidden />More like this</button>
                    <button type="button" className="row-link" onClick={() => answer(row, -1)}><ThumbsDown aria-hidden />Not for me</button>
                  </span>
                  )
              : undefined}
          onNearEnd={isRecRow(row) ? () => paging.extendRow(row.id, row.have) : undefined}
        >
          {row.items.map(it => <RecCard key={it.id} item={it} onRemove={isRecRow(row) ? notInterested : undefined} />)}
        </Row>,
      )
    }
    if (row === anchor && !tab) shelves.push(<Downloads key="downloads" />)
    if (row === aiAfter) shelves.push(aiRow)
  }
  if (!aiAfter) shelves.push(aiRow)

  return (
    <>
      {pick ? <PickBillboard item={pick.item} label={pick.label} /> : <div className="masthead-spacer" />}
      <div className="shelves" onClickCapture={e => noteSource(e)}>{shelves}</div>
      <div ref={bottom} className="feed-end" aria-hidden />
    </>
  )
}

// ---- AI (optional: only when a provider is connected, and a model is asked only on a button press) ----

function useAiPicks (): [AiPicksResponse | null, (a: AiPicksResponse) => void] {
  const [ai, setAi] = useState<AiPicksResponse | null>(null)
  const priv = usePrivate()
  useEffect(() => {
    let live = true
    api.aiPicks().then(a => { if (live) setAi(a) }).catch(() => { if (live) setAi(null) })
    return () => { live = false }
  }, [priv])
  return [ai, setAi]
}

const DAY_MS = 86_400_000
function since (at: number): string {
  const days = Math.floor((Date.now() - at) / DAY_MS)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

function AiPicksRow ({ ai, onAi, tab, hidden, onRemove }: {
  ai: AiPicksResponse | null; onAi: (a: AiPicksResponse) => void; tab?: MediaType; hidden: Set<string>; onRemove: (it: RecItem) => void
}) {
  const [busy, setBusy] = useState(false)
  if (!ai || (!ai.available && !ai.picks)) return null
  const ask = async () => {
    setBusy(true)
    try { onAi(await api.makeAiPicks()) } catch (err) { toast(`No AI picks this time. ${(err as Error).message}`) }
    setBusy(false)
  }
  const items = (ai.picks?.items ?? []).filter(it => (!tab || it.type === tab) && !hidden.has(it.id))
  if (!items.length) {
    if (!ai.available) return null
    return (
      <section className="ai-invite" aria-labelledby="ai-invite-h">
        <div className="ai-invite-text">
          <h2 id="ai-invite-h" className="row-title"><Sparkles aria-hidden className="ai-spark" />AI picks</h2>
          <p className="account-note">{ai.picks ? 'Ask again for new picks from your taste.' : 'Picks from your taste, chosen by AI and checked against the catalogue.'} {ai.hint ? `${ai.hint}.` : ''}</p>
        </div>
        <button type="button" className="button secondary" onClick={() => { void ask() }} disabled={busy}>
          {busy && <span className="spinner" aria-hidden />}
          {busy ? 'Asking…' : 'Get AI picks'}
        </button>
      </section>
    )
  }
  return (
    <Row
      title="AI picks"
      caption={`${ai.picks!.model} · ${since(ai.picks!.at)}`}
      id="row-ai"
      className="row-rec row-kind-ai"
      source="ai"
      aside={ai.available
        ? (
          <button type="button" className="row-link" onClick={() => { void ask() }} disabled={busy} title={ai.hint}>
            {busy ? <span className="spinner" aria-hidden /> : <RefreshCw aria-hidden />}{busy ? 'Asking…' : 'Refresh'}
          </button>
          )
        : undefined}
    >
      {items.map(it => <RecCard key={it.id} item={it} onRemove={onRemove} />)}
    </Row>
  )
}

type AiSearchLoad = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; data: AiSearchResponse } | { state: 'error'; message: string }

/** "Ask AI" above the search results: asks only when pressed; a repeat of a saved search is answered from it. */
function AiSearch ({ q, hint }: { q: string; hint?: string }) {
  const [load, setLoad] = useState<AiSearchLoad>({ state: 'idle' })
  const ask = (refresh: boolean) => {
    setLoad({ state: 'loading' })
    api.aiSearch(q, refresh).then(data => setLoad({ state: 'ok', data })).catch(err => setLoad({ state: 'error', message: (err as Error).message }))
  }
  if (load.state === 'idle') {
    return (
      <div className="ai-ask">
        <button type="button" className="button secondary" onClick={() => ask(false)}><Sparkles aria-hidden />Ask AI</button>
        <span className="account-note">Suggestions for “{q}” in your own words{hint ? ` · ${hint}` : ''}</span>
      </div>
    )
  }
  return (
    <section className="ai-results" aria-labelledby="ai-results-h" aria-live="polite" onClickCapture={e => noteSource(e, 'ai-search')}>
      <h2 id="ai-results-h" className="page-heading"><Sparkles aria-hidden className="ai-spark" />AI suggestions</h2>
      {load.state === 'loading' && <div className="grid">{Array.from({ length: 6 }, (_, i) => <PosterSkeleton key={i} />)}</div>}
      {load.state === 'error' && <p className="notice" role="alert">{load.message}</p>}
      {load.state === 'ok' && (
        <>
          <p className="account-note">
            {load.data.model}{load.data.cached ? ` · saved answer from ${since(load.data.at)}` : ''}
            {' · '}<button type="button" className="text-button inline" onClick={() => ask(true)}>Ask again</button>
          </p>
          {load.data.items.length
            ? <div className="grid">{load.data.items.map(it => <RecCard key={it.id} item={it} />)}</div>
            : <p className="notice">Nothing it suggested could be found in the catalogue. Try different words.</p>}
        </>
      )}
    </section>
  )
}

/** The featured title, full-bleed: the top pick with its reason, or the most popular film before that. */
function PickBillboard ({ item: t, label }: { item: RecItem; label: string }) {
  const [loaded, onLoad] = useLoaded(t.background)
  const taste = useTitleState(t.type, t.id, { initial: EMPTY_STATE, source: 'billboard' })
  // Not on phones, where the billboard shows the poster.
  const trailer = useTrailer(t.type, t.id, { media: '(min-width: 641px)' })
  const href = `/title/${t.type}/${t.id}`
  const meta = [t.year, t.runtime, t.genres.slice(0, 2).join(', ')].filter(Boolean)
  return (
    <section className="billboard" aria-label={label === 'Popular now' ? 'Popular now' : 'Top pick for you'}>
      <picture className="billboard-art">
        {t.poster && <source media="(max-width: 640px)" srcSet={t.poster} />}
        <img src={t.background} alt="" decoding="async" fetchPriority="high" data-loaded={loaded || undefined} onLoad={onLoad} />
      </picture>
      <TrailerVideo trailer={trailer} />
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
          <button type="button" className="round-button" aria-label={`Watch the trailer for ${t.name}`} data-tip="Trailer" onClick={() => showPreview(t)}>
            <Clapperboard aria-hidden />
          </button>
          <TasteButtons actions={taste} name={t.name} listOnly />
          <TrailerButton trailer={trailer} />
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
    api.rate(it.type, it.id, value, 'onboarding').then(s => {
      noteMark(it.id, s)
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
      {load.state === 'ok' && load.data.slice(0, 20).map(t => <TitleCard key={t.id} title={t} />)}
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


/** Home (films and series together), or the Films or Series tab: the same page, one kind of title. */
export function Home ({ initialQuery, tab }: { initialQuery: string; tab?: MediaType }) {
  const base = TABS.find(t => t.tab === tab)?.href ?? '/'
  const [query, setQuery] = useState(initialQuery)
  const results = useQueryResults(query)
  const [ai, setAi] = useAiPicks()
  const input = useRef<HTMLInputElement>(null)
  const scrolled = useScrolled()
  const q = query.trim()
  useDocumentTitle(q ? `Results for “${q}”` : tab ? TABS.find(t => t.tab === tab)?.label : undefined)

  // Keep the query in the URL so Back from a title returns to the same results.
  useEffect(() => {
    const t = setTimeout(() => {
      const url = query.trim() ? `${base}?q=${encodeURIComponent(query.trim())}` : base
      if (url !== location.pathname + location.search) replaceUrl(url)
    }, 300)
    return () => clearTimeout(t)
  }, [query, base])

  const active = usePageActive()
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== input.current) { e.preventDefault(); input.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <main className={`home${results ? ' is-searching' : ''}`}>
      <h1 className="sr-only">nexttupp</h1>
      <header className={`masthead${scrolled || results ? ' is-solid' : ''}`}>
        <div className="masthead-start">
          <Wordmark />
          <BrowseTabs current={base} onNavigate={() => setQuery('')} />
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
        <section className="results" aria-live="polite" onClickCapture={e => noteSource(e, 'search')}>
          {ai?.available && q.length >= 3 && <AiSearch key={q} q={q} hint={ai.hint} />}
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
            <div className="grid">{results.data.map(t => <TitleCard key={`${t.type}-${t.id}`} title={t} showType />)}</div>
          )}
        </section>
      ) : <Feed key={tab ?? 'all'} tab={tab} ai={ai} onAi={setAi} />}
    </main>
  )
}
