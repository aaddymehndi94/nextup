import { useEffect, useState } from 'react'
import { Check, Play, Trash2 } from 'lucide-react'
import { api, type LibraryItem } from '../api.ts'
import { bytes, speed } from '../format.ts'
import { useLoaded } from '../hooks.ts'
import { navigate } from '../router.ts'
import { Row } from './Row.tsx'

/** Titles the viewer chose to keep. Hidden when there are none. */
export function Downloads () {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const load = () => api.library().then(i => { if (live) setItems(i) }).catch(() => {})
    load()
    // Progress moves while downloading; poll gently, and not at all in a background tab.
    const id = setInterval(() => { if (!document.hidden) load() }, 3000)
    return () => { live = false; clearInterval(id) }
  }, [])

  if (!items || items.length === 0) return null

  const play = (it: LibraryItem) => {
    const q = new URLSearchParams({ ih: it.infoHash, f: String(it.fileIdx), fn: it.fileName, type: it.type, id: it.imdbId, s: it.streamId, n: it.title })
    navigate(`/watch?${q}`)
  }

  const remove = (it: LibraryItem) => {
    api.unkeep(it.id, true).then(() => setItems(prev => prev?.filter(x => x.id !== it.id) ?? null)).catch(() => {})
    setConfirming(null)
  }

  return (
    <Row title="Downloads" variant="landscape">
      {items.map(it => {
        const s = it.stats
        const progress = s?.progress ?? 0
        const done = progress >= 1
        return (
          <article key={it.id} className="download">
            <button className="download-art" onClick={() => play(it)} aria-label={`Play ${it.title}`}>
              <DownloadArt imdbId={it.imdbId} title={it.title} />
              <span className="download-play" aria-hidden><Play size={20} fill="currentColor" /></span>
              {!done && <span className="download-progress" aria-hidden><span style={{ width: `${Math.max(2, progress * 100)}%` }} /></span>}
            </button>
            <div className="download-text">
              <span className="download-title">{it.title}</span>
              <span className="download-status">
                {done
                  ? <><Check size={14} aria-hidden />Ready offline · {bytes(s?.fileSize)}</>
                  : s
                    ? <>{Math.floor(progress * 100)}% of {bytes(s.fileSize)} · {speed(s.downloadSpeed)} · {s.peers} {s.peers === 1 ? 'peer' : 'peers'}</>
                    : 'Waiting to resume…'}
              </span>
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

function DownloadArt ({ imdbId, title }: { imdbId: string; title: string }) {
  const src = `https://images.metahub.space/background/medium/${imdbId}/img`
  const [failed, setFailed] = useState(false)
  const [loaded, onLoad] = useLoaded(src)
  if (failed) return <span className="download-fallback">{title}</span>
  return <img src={src} alt="" loading="lazy" decoding="async" data-loaded={loaded || undefined} onLoad={onLoad} onError={() => setFailed(true)} />
}
