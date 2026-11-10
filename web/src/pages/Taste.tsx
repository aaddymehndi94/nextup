import { useCallback, useEffect, useState } from 'react'
import type { TasteFeature, TasteFeatureKind, TasteSignal, TasteSummary } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useDocumentTitle, useLoaded } from '../hooks.ts'
import { onLinkClick } from '../router.ts'
import { toast } from '../toast.ts'
import { TopBar } from '../components/TopBar.tsx'

// "What nexttupp thinks you like": the recommender's beliefs about this profile, the evidence behind
// each, and a lever on every one. Read top to bottom: the sentence, what it leans on, what it's built from.

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string }

const KIND: Record<TasteFeatureKind, string> = {
  genre: 'Genre', genres: 'Genre mix', era: 'Genre and decade', decade: 'Decade',
  director: 'Director', writer: 'Writer', cast: 'Actor', country: 'Country',
}

function joinNames (names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function Taste () {
  const [load, setLoad] = useState<Load<TasteSummary>>({ state: 'loading' })
  // The list of signals is kept as first loaded, so undoing one leaves it in place with a way back.
  const [signals, setSignals] = useState<TasteSignal[] | null>(null)
  useDocumentTitle('Your taste')

  const refresh = useCallback(() => api.taste().then(data => {
    setLoad({ state: 'ok', data })
    setSignals(prev => prev ?? data.signals)
  }), [])

  useEffect(() => {
    refresh().catch(err => setLoad({ state: 'error', message: (err as Error).message }))
  }, [refresh])

  const setPref = (f: TasteFeature, value: 1 | -1 | 0) => {
    if (load.state !== 'ok') return
    const before = load.data
    const patch = (list: TasteFeature[]) => list.map(x => (x.key === f.key ? { ...x, pref: value || undefined } : x))
    setLoad({ state: 'ok', data: { ...before, likes: patch(before.likes), dislikes: patch(before.dislikes) } })
    api.setFeaturePref(f.key, value)
      .then(data => setLoad({ state: 'ok', data }))
      .catch(err => { setLoad({ state: 'ok', data: before }); toast(`Couldn’t save that. ${(err as Error).message}`) })
  }

  return (
    <main className="taste-page">
      <TopBar solid />
      {load.state === 'loading' && <div className="taste-body" aria-busy="true"><div className="skeleton-line" style={{ width: '40%', height: '2rem' }} /></div>}
      {load.state === 'error' && (
        <div className="page-notice">
          <p className="empty-title">Couldn’t load your taste</p>
          <p className="notice">{load.message}</p>
        </div>
      )}
      {load.state === 'ok' && <TasteBody data={load.data} signals={signals ?? []} onPref={setPref} onChanged={() => { void refresh().catch(() => {}) }} />}
    </main>
  )
}

function TasteBody ({ data, signals, onPref, onChanged }: {
  data: TasteSummary
  signals: TasteSignal[]
  onPref: (f: TasteFeature, v: 1 | -1 | 0) => void
  onChanged: () => void
}) {
  const ratings = signals.filter(s => ['Liked', 'Disliked', 'Not interested'].includes(s.label))
  const watched = signals.filter(s => !ratings.includes(s))
  const shown = new Set([...data.likes, ...data.dislikes].map(f => f.key))
  const otherPrefs = data.prefs.filter(p => !shown.has(p.key))
  const lean = Math.round(data.confidence * 100)

  return (
    <div className="taste-body">
      <header className="taste-head">
        <h1 className="taste-title">What nexttupp thinks you like</h1>
        <p className="taste-summary">{data.summary}</p>
        <p className="taste-facts">
          {data.coldStart
            ? <>Picks are mostly what’s popular and well rated until there are {Math.max(1, 3 - data.counts.positive)} more likes.</>
            : <>Your picks lean {lean}% on your taste and {100 - lean}% on what’s widely rated.</>}
          {' '}
          {data.cf.available
            ? 'They blend how close a title is to what you like (genre, people, era, story) with what people who liked the same films enjoyed.'
            : 'They come from how close a title is to what you like: genre, people, era and story.'}
        </p>
        {data.coldStart && <a className="button secondary taste-cta" href="/" onClick={onLinkClick}>Rate a few on Home</a>}
      </header>

      {(data.likes.length > 0 || data.dislikes.length > 0) && (
        <div className="taste-columns">
          <FeatureList title="You lean towards" empty="Nothing stands out yet." features={data.likes} lead="From" onPref={onPref} />
          <FeatureList title="You’re less keen on" empty="Nothing you’ve turned down shares much yet." features={data.dislikes} lead="From" onPref={onPref} />
        </div>
      )}

      {otherPrefs.length > 0 && (
        <section className="taste-section" aria-labelledby="prefs-h">
          <h2 id="prefs-h" className="section-title">Your adjustments</h2>
          <ul className="feature-list">
            {otherPrefs.map(f => <FeatureRow key={f.key} f={f} onPref={onPref} />)}
          </ul>
        </section>
      )}

      <div className="taste-columns">
        <SignalList
          title="Your ratings"
          empty="You haven’t rated anything yet. Like or dislike titles from their page, or while getting started on Home."
          signals={ratings}
          onChanged={onChanged}
        />
        <SignalList
          title="From what you’ve watched"
          empty="Nothing yet. Titles you finish, stop early or add to My List show up here."
          signals={watched}
          onChanged={onChanged}
        />
      </div>
    </div>
  )
}

function FeatureList ({ title, empty, features, lead, onPref }: {
  title: string; empty: string; features: TasteFeature[]; lead: string; onPref: (f: TasteFeature, v: 1 | -1 | 0) => void
}) {
  return (
    <section className="taste-section" aria-label={title}>
      <h2 className="section-title">{title}</h2>
      {features.length === 0
        ? <p className="notice">{empty}</p>
        : <ul className="feature-list">{features.map(f => <FeatureRow key={f.key} f={f} lead={lead} onPref={onPref} />)}</ul>}
    </section>
  )
}

/** One belief ("Denis Villeneuve", "Romantic dramas"), the titles behind it, and More / Never / Reset. */
function FeatureRow ({ f, lead = 'From', onPref }: { f: TasteFeature; lead?: string; onPref: (f: TasteFeature, v: 1 | -1 | 0) => void }) {
  const why = f.evidence.length ? `${lead} ${joinNames(f.evidence)}` : f.pref === 1 ? 'You asked for more' : f.pref === -1 ? 'You asked never to see this' : ''
  return (
    <li className={`feature${f.pref === -1 ? ' is-muted' : ''}`}>
      <div className="feature-main">
        <span className="feature-label">{f.label}</span>
        <span className="feature-why"><span className="feature-kind">{KIND[f.kind] ?? 'Feature'}</span>{why && <> · {why}</>}</span>
      </div>
      <div className="feature-controls" role="group" aria-label={f.label}>
        <button type="button" className="chip" aria-pressed={f.pref === 1} aria-label={`More ${f.label}`} onClick={() => onPref(f, f.pref === 1 ? 0 : 1)}>More</button>
        <button type="button" className="chip" aria-pressed={f.pref === -1} aria-label={`Never recommend ${f.label}`} onClick={() => onPref(f, f.pref === -1 ? 0 : -1)}>Never</button>
        {f.pref !== undefined && <button type="button" className="text-button" aria-label={`Reset ${f.label}`} onClick={() => onPref(f, 0)}>Reset</button>}
      </div>
    </li>
  )
}

type Undo = { kind: 'rating' | 'dismiss' | 'list'; label: string } | { kind: 'forget'; label: string }

function undoFor (s: TasteSignal): Undo {
  if (s.label === 'Liked' || s.label === 'Disliked') return { kind: 'rating', label: 'Undo' }
  if (s.label === 'Not interested') return { kind: 'dismiss', label: 'Undo' }
  if (s.label === 'On your list') return { kind: 'list', label: 'Remove' }
  return { kind: 'forget', label: 'Forget' }
}

function SignalList ({ title, empty, signals, onChanged }: { title: string; empty: string; signals: TasteSignal[]; onChanged: () => void }) {
  return (
    <section className="taste-section" aria-label={title}>
      <h2 className="section-title">{title}</h2>
      {signals.length === 0
        ? <p className="notice">{empty}</p>
        : <ul className="signal-list">{signals.map(s => <SignalRow key={s.item.id} s={s} onChanged={onChanged} />)}</ul>}
    </section>
  )
}

/** One title the profile reacted to, what that counted as, and how to take it back. */
function SignalRow ({ s, onChanged }: { s: TasteSignal; onChanged: () => void }) {
  const [undone, setUndone] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const u = undoFor(s)
  const { type, id, name } = s.item

  const run = (p: Promise<unknown>, done: boolean) => {
    setBusy(true)
    p.then(() => { setUndone(done); onChanged() })
      .catch(err => toast(`Couldn’t change that. ${(err as Error).message}`))
      .finally(() => { setBusy(false); setConfirming(false) })
  }
  const undo = () => {
    if (u.kind === 'rating') run(api.rate(type, id, 0, 'taste'), true)
    else if (u.kind === 'dismiss') run(api.undismiss(type, id), true)
    else if (u.kind === 'list') run(api.removeFromList(type, id), true)
    else run(api.clearProgress(type, id, true), true)
  }
  const restore = () => {
    if (s.label === 'Liked') run(api.rate(type, id, 1, 'taste'), false)
    else if (s.label === 'Disliked') run(api.rate(type, id, -1, 'taste'), false)
    else if (u.kind === 'dismiss') run(api.dismiss(type, id, 'not_interested'), false)
    else if (u.kind === 'list') run(api.addToList(type, id), false)
  }

  const status = undone
    ? u.kind === 'forget' ? 'Forgotten' : u.kind === 'list' ? 'Removed from My List' : 'Undone'
    : s.label
  return (
    <li className={`signal${undone ? ' is-undone' : ''}`}>
      <a className="signal-title" href={`/title/${type}/${id}`} onClick={onLinkClick}>
        <SignalPoster src={s.item.poster} />
        <span className="signal-text">
          <span className="signal-name">{name}</span>
          <span className="signal-meta">{[s.item.year, status].filter(Boolean).join(' · ')}</span>
        </span>
      </a>
      <span className="signal-actions">
        {confirming
          ? (
            <span className="confirm-actions" role="group" aria-label={`Forget watching ${name}?`}>
              <button type="button" className="chip danger" onClick={undo} disabled={busy} autoFocus>Forget</button>
              <button type="button" className="chip" onClick={() => setConfirming(false)}>Keep</button>
            </span>
            )
          : undone
            ? u.kind !== 'forget' && <button type="button" className="text-button" onClick={restore} disabled={busy}>Restore</button>
            : (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                aria-label={`${u.label} ${s.label.toLowerCase()}: ${name}`}
                title={u.kind === 'forget' ? 'That wasn’t me: drop it from your history and taste' : undefined}
                onClick={() => (u.kind === 'forget' ? setConfirming(true) : undo())}
              >
                {u.label}
              </button>
              )}
      </span>
    </li>
  )
}

function SignalPoster ({ src }: { src?: string }) {
  const [failed, setFailed] = useState(!src)
  const [loaded, onLoad] = useLoaded(src)
  return (
    <span className="signal-poster" aria-hidden>
      {!failed && <img src={src} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />}
    </span>
  )
}
