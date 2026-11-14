import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronRight, Play, Trash2 } from 'lucide-react'
import { KEPT_DAYS } from '../../../shared/storage.ts'
import { api, type LibraryItem, imageUrl } from '../api.ts'
import { bytes, speed } from '../format.ts'
import { useLoaded, usePageActive } from '../hooks.ts'
import { navigateThrough, onLinkClick } from '../router.ts'
import { toast } from '../toast.ts'
import { Row } from './Row.tsx'

/** The kept downloads, polled gently while they're on screen (progress moves). */
export function useDownloads (): { items: LibraryItem[] | null; reload: () => void; patch: (id: string, next: LibraryItem | null) => void } {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const active = usePageActive()
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    if (!active) return
    let live = true
    const load = () => api.library().then(i => { if (live) setItems(i) }).catch(() => {})
    load()
    // Not at all in a background tab, or while this page is kept behind another.
    const id = setInterval(() => { if (!document.hidden) load() }, 3000)
    return () => { live = false; clearInterval(id) }
  }, [active, tick])

  const patch = useCallback((id: string, next: LibraryItem | null) => {
    setItems(prev => prev && (next ? prev.map(x => (x.id === id ? { ...x, ...next, stats: next.stats ?? x.stats } : x)) : prev.filter(x => x.id !== id)))
  }, [])
  return { items, reload, patch }
}

/**
 * Plays a download. The title's page goes beneath the player, so Back lands there (another episode, the
 * details) rather than on the page the download was started from.
 */
export function playDownload (it: LibraryItem) {
  const q = new URLSearchParams({ ih: it.infoHash, type: it.type, id: it.imdbId, s: it.streamId, n: it.title })
  if (it.fileIdx >= 0) q.set('f', String(it.fileIdx))
  if (it.fileName) q.set('fn', it.fileName)
  navigateThrough(`/title/${it.type}/${it.imdbId}`, `/watch?${q}`)
}

/** Deletes a download and its file. Resolves false when it couldn't. */
export function deleteDownload (it: LibraryItem): Promise<boolean> {
  return api.unkeep(it.id, true)
    .then(() => { toast(`Deleted ${it.title}.`); return true })
    .catch(err => { toast(`Couldn’t delete that. ${(err as Error).message}`); return false })
}

export const isDone = (it: LibraryItem) => (it.stats?.progress ?? 0) >= 1

/** How long a finished download stays: "Kept forever", or "Kept 12 more days" (unless it's played). */
export function keptFor (it: LibraryItem, now = Date.now()): string | null {
  if (it.forever) return 'Kept forever'
  if (!it.expiresAt) return null
  const days = Math.max(1, Math.ceil((it.expiresAt - now) / 86_400_000))
  return `Kept ${days} more ${days === 1 ? 'day' : 'days'}`
}

/** Where a download is, in a few words. */
export function downloadStatus (it: LibraryItem): { text: string; done: boolean; progress: number } {
  const s = it.stats
  const progress = s?.progress ?? it.progress ?? 0
  const size = s?.fileSize ?? it.fileSize
  if (progress >= 1) return { text: `Ready to watch offline · ${bytes(size)}`, done: true, progress }
  const pct = Math.floor(progress * 100)
  const sofar = size ? `${pct}% of ${bytes(size)}` : `${pct}%`
  if (it.paused) return { text: progress > 0 ? `Paused · ${sofar}` : 'Paused', done: false, progress }
  if (it.pending) return { text: waiting(it.swarm), done: false, progress }
  // Kept and known, but not open yet (the app has just started and is checking what's on disk).
  if (!s) return { text: progress > 0 ? `Starting · ${sofar}` : 'Starting…', done: false, progress }
  if (s.downloadSpeed > 0) return { text: `${sofar} · ${speed(s.downloadSpeed)} · ${timeLeft((s.fileSize - s.downloaded) / s.downloadSpeed)}`, done: false, progress }
  return { text: `${sofar} · ${s.peers ? `${s.peers} ${s.peers === 1 ? 'peer' : 'peers'}, waiting for data` : 'Looking for peers…'}`, done: false, progress }
}

function timeLeft (sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return 'almost done'
  if (sec < 60) return 'under a minute left'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min left`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60 ? `${min % 60} min ` : ''}left`
}

/** A source kept before anyone could send its file list: we keep asking (and retry every few minutes). */
function waiting (swarm: LibraryItem['swarm']): string {
  if (!swarm || swarm.peers === 0) return 'Looking for peers…'
  return `Connecting · ${swarm.peers} ${swarm.peers === 1 ? 'peer' : 'peers'} found`
}

/** Home's Downloads shelf: what's kept, one click to play. Hidden when there are none. */
export function Downloads () {
  const { items, patch } = useDownloads()
  const [confirming, setConfirming] = useState<string | null>(null)
  if (!items || items.length === 0) return null

  const remove = (it: LibraryItem) => {
    setConfirming(null)
    void deleteDownload(it).then(ok => { if (ok) patch(it.id, null) })
  }

  return (
    <Row
      title="Downloads"
      variant="landscape"
      caption={`Removed once you’ve watched them, or after ${KEPT_DAYS} days without playing, unless kept forever`}
      aside={<a className="row-link" href="/downloads" onClick={onLinkClick}>See all<ChevronRight aria-hidden /></a>}
    >
      {items.map(it => {
        const st = downloadStatus(it)
        return (
          <article key={it.id} className="download">
            <button className="download-art" onClick={() => playDownload(it)} aria-label={`Play ${it.title}`}>
              <DownloadArt imdbId={it.imdbId} title={it.title} />
              <span className="download-play" aria-hidden><Play size={20} fill="currentColor" /></span>
              {!st.done && <span className="download-progress" aria-hidden><span style={{ width: `${Math.max(2, st.progress * 100)}%` }} /></span>}
            </button>
            <div className="download-text">
              <span className="download-title">{it.title}</span>
              <span className="download-status">{st.done && <Check size={14} aria-hidden />}{st.text}</span>
            </div>
            {confirming === it.id
              ? (
                <span className="download-confirm" role="group" aria-label={`Delete ${it.title}?`}>
                  <button className="chip danger" onClick={() => remove(it)}>Delete</button>
                  <button className="chip" onClick={() => setConfirming(null)}>Keep</button>
                </span>
                )
              : (
                <button className="icon-button download-delete" onClick={() => setConfirming(it.id)} aria-label={`Delete download of ${it.title}`}>
                  <Trash2 size={18} />
                </button>
                )}
          </article>
        )
      })}
    </Row>
  )
}

export function DownloadArt ({ imdbId, title }: { imdbId: string; title: string }) {
  const src = imageUrl(`https://images.metahub.space/background/medium/${imdbId}/img`)
  const [failed, setFailed] = useState(false)
  const [loaded, onLoad] = useLoaded(src)
  if (failed) return <span className="download-fallback">{title}</span>
  return <img src={src} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />
}
