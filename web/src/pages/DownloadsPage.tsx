import { useEffect, useState } from 'react'
import { Check, Download, FolderOpen, HardDrive, Pause, Pin, Play, RotateCw, Trash2 } from 'lucide-react'
import { KEPT_DAYS, type StorageReport } from '../../../shared/storage.ts'
import { api, type LibraryItem } from '../api.ts'
import { desktop } from '../desktop.ts'
import { bytes } from '../format.ts'
import { useDocumentTitle, usePageActive } from '../hooks.ts'
import { onLinkClick } from '../router.ts'
import { toast } from '../toast.ts'
import { DownloadArt, deleteDownload, downloadStatus, isDone, keptFor, playDownload, useDownloads } from '../components/Downloads.tsx'
import { TabMasthead } from '../components/TabMasthead.tsx'

/** Everything kept to watch later: play, pause or delete each, and see how much room is left. */
export function DownloadsPage () {
  useDocumentTitle('Downloads')
  const { items, patch, reload } = useDownloads()
  const [storage, setStorage] = useState<StorageReport | null>(null)
  const active = usePageActive()
  useEffect(() => { if (active) api.storage().then(setStorage).catch(() => {}) }, [active, items?.length])

  const unfinished = (items ?? []).filter(it => !isDone(it))
  const running = unfinished.filter(it => !it.paused)
  const openFolder = desktop?.openFolder && storage ? () => { void desktop!.openFolder!(storage.folder.path).then(ok => { if (!ok) toast('Couldn’t open the folder.') }) } : null

  const setPaused = (list: LibraryItem[], pause: boolean) => {
    for (const it of list) {
      patch(it.id, { ...it, paused: pause || undefined })
      ;(pause ? api.pauseDownload(it.id) : api.resumeDownload(it.id))
        .then(next => patch(it.id, { ...next, stats: it.stats }))
        .catch(err => { toast(`Couldn’t ${pause ? 'pause' : 'resume'} ${it.title}. ${(err as Error).message}`); reload() })
    }
  }

  const setForever = (it: LibraryItem, forever: boolean) => {
    patch(it.id, { ...it, forever })
    api.keepForever(it.id, forever)
      .then(next => { patch(it.id, { ...next, stats: it.stats }); toast(forever ? `${it.title} is kept forever.` : `${it.title} goes after ${KEPT_DAYS} days without playing.`) })
      .catch(err => { toast(`Couldn’t change that. ${(err as Error).message}`); reload() })
  }

  const summary = [
    items && items.length > 0 ? `${items.length} ${items.length === 1 ? 'title' : 'titles'}` : null,
    storage?.disk ? `${bytes(storage.disk.free)} free on this computer` : null,
  ].filter(Boolean).join(' · ')

  return (
    <main className="tab-page">
      <TabMasthead current="/downloads" />
      <div className="tab-body is-measured">
        <header className="tab-head">
          <div className="tab-heading">
            <h1 className="tab-title">Downloads</h1>
            {summary && <p className="tab-sub">{summary}</p>}
          </div>
          {items && items.length > 0 && (
            <div className="tab-actions">
              {running.length > 0
                ? <button type="button" className="chip" onClick={() => setPaused(running, true)}><Pause aria-hidden />Pause all</button>
                : unfinished.length > 0 && <button type="button" className="chip" onClick={() => setPaused(unfinished, false)}><RotateCw aria-hidden />Resume all</button>}
              {openFolder && <button type="button" className="chip" onClick={openFolder}><FolderOpen aria-hidden />Open folder</button>}
            </div>
          )}
        </header>

        {items === null && <div className="dl-list" aria-busy="true">{[0, 1, 2].map(i => <div key={i} className="dl-item is-skeleton"><span className="dl-art" /></div>)}</div>}
        {items?.length === 0 && (
          <div className="tab-empty">
            <p className="empty-title">No downloads yet</p>
            <p className="notice">Press <Download className="inline-icon" aria-label="Download" /> on a film or episode to keep it here. It plays straight away, even without internet.</p>
            <a className="button secondary" href="/" onClick={onLinkClick}>Find something to watch</a>
          </div>
        )}
        {items && items.length > 0 && (
          <ul className="dl-list">
            {items.map(it => <DownloadItem key={it.id} it={it} onPause={p => setPaused([it], p)} onForever={f => setForever(it, f)} onDeleted={() => patch(it.id, null)} />)}
          </ul>
        )}

        <p className="tab-foot">
          Downloads go once you’ve watched them, or after {KEPT_DAYS} days without playing.
          Press <Pin className="inline-icon" aria-label="Keep forever" /> to keep one forever.{' '}
          <a className="text-button inline" href="/storage" onClick={onLinkClick}><HardDrive className="inline-icon" aria-hidden />Manage storage</a>
        </p>
      </div>
    </main>
  )
}

function DownloadItem ({ it, onPause, onForever, onDeleted }: { it: LibraryItem; onPause: (pause: boolean) => void; onForever: (forever: boolean) => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const st = downloadStatus(it)
  // How long it stays, once there's nothing more to say about the download itself.
  const kept = st.done || it.forever ? keptFor(it) : null
  return (
    <li className={`dl-item${it.paused ? ' is-paused' : ''}`}>
      <button type="button" className="dl-art download-art" onClick={() => playDownload(it)} aria-label={`Play ${it.title}`}>
        <DownloadArt imdbId={it.imdbId} title={it.title} />
        <span className="download-play" aria-hidden><Play size={20} fill="currentColor" /></span>
        {!st.done && <span className="download-progress" aria-hidden><span style={{ width: `${Math.max(2, st.progress * 100)}%` }} /></span>}
      </button>
      <div className="dl-text">
        <span className="dl-title">{it.title}</span>
        <span className="dl-status">{st.done && <Check aria-hidden />}{st.text}{kept && <span className="dl-kept"> · {kept}</span>}</span>
      </div>
      <div className="dl-actions">
        {confirming
          ? (
            <span className="download-confirm" role="group" aria-label={`Delete ${it.title}?`}>
              <button type="button" className="chip danger" onClick={() => { setConfirming(false); void deleteDownload(it).then(ok => { if (ok) onDeleted() }) }}>Delete</button>
              <button type="button" className="chip" onClick={() => setConfirming(false)}>Keep</button>
            </span>
            )
          : (
            <>
              {!st.done && (it.paused
                ? <button type="button" className="chip" aria-label={`Resume downloading ${it.title}`} onClick={() => onPause(false)}><RotateCw aria-hidden />Resume</button>
                : (
                  <button type="button" className="icon-button" data-tip="Pause" aria-label={`Pause downloading ${it.title}`} onClick={() => onPause(true)}>
                    <Pause aria-hidden />
                  </button>
                  ))}
              <button type="button" className="icon-button dl-forever" aria-pressed={Boolean(it.forever)} data-tip={it.forever ? 'Kept forever' : 'Keep forever'}
                aria-label={`Keep ${it.title} forever`} onClick={() => onForever(!it.forever)}>
                <Pin aria-hidden fill={it.forever ? 'currentColor' : 'none'} />
              </button>
              <button type="button" className="icon-button" data-tip="Delete" aria-label={`Delete ${it.title}`} onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden />
              </button>
            </>
            )}
      </div>
    </li>
  )
}
