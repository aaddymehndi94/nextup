import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { RecItem } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useDocumentTitle, usePageActive } from '../hooks.ts'
import { noteMark, setTitleInList } from '../marks.ts'
import { onLinkClick } from '../router.ts'
import { toast } from '../toast.ts'
import { PosterSkeleton } from '../components/PosterCard.tsx'
import { RecCard } from '../components/RecCard.tsx'
import { TabMasthead } from '../components/TabMasthead.tsx'

type Load = { state: 'loading' } | { state: 'ok'; items: RecItem[] } | { state: 'error'; message: string }

/** Every title on this profile's list, newest first. */
export function MyList () {
  useDocumentTitle('My List')
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const active = usePageActive()

  // Kept alive behind a title page: back here, the list may have changed there.
  useEffect(() => {
    if (!active) return
    let live = true
    api.myList()
      .then(items => { if (live) setLoad({ state: 'ok', items }) })
      .catch(err => { if (live) setLoad(prev => (prev.state === 'ok' ? prev : { state: 'error', message: (err as Error).message })) })
    return () => { live = false }
  }, [active])

  const remove = (it: RecItem) => {
    const back = load
    setLoad(prev => (prev.state === 'ok' ? { state: 'ok', items: prev.items.filter(x => x.id !== it.id) } : prev))
    api.removeFromList(it.type, it.id)
      .then(s => {
        noteMark(it.id, s)
        toast(`Removed ${it.name} from My List.`, {
          label: 'Undo',
          run: () => { setLoad(back); setTitleInList(it.type, it.id, true) },
        })
      })
      .catch(err => { setLoad(back); toast(`Couldn’t remove that. ${(err as Error).message}`) })
  }

  const items = load.state === 'ok' ? load.items : []
  return (
    <main className="tab-page">
      <TabMasthead current="/list" />
      <div className="tab-body">
        <header className="tab-head">
          <h1 className="tab-title">My List</h1>
          {items.length > 0 && <p className="tab-sub">{items.length} {items.length === 1 ? 'title' : 'titles'}</p>}
        </header>
        {load.state === 'loading' && <div className="grid" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} />)}</div>}
        {load.state === 'error' && <p className="notice" role="alert">My List didn’t load. {load.message}</p>}
        {load.state === 'ok' && items.length === 0 && (
          <div className="tab-empty">
            <p className="empty-title">Nothing on your list yet</p>
            <p className="notice">Press <Plus className="inline-icon" aria-label="My List" /> on any film or series to save it here for later.</p>
            <a className="button secondary" href="/" onClick={onLinkClick}>Find something to watch</a>
          </div>
        )}
        {items.length > 0 && (
          <div className="grid">
            {items.map(it => <RecCard key={it.id} item={it} onRemove={remove} removeLabel="Remove from My List" listed />)}
          </div>
        )}
      </div>
    </main>
  )
}
