import { useEffect, useRef, useState } from 'react'
import { Check, Play, Plus, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import type { MediaType, TitleDetail, TitleSummary } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { rateTitle, setTitleInList, useMark } from '../marks.ts'
import { pause as pauseMusic, playerState, toggle as toggleMusic } from '../music/player.ts'
import { closePreview, navigate, openPreview } from '../router.ts'
import { loadYouTube, YT_ENDED, YT_PLAYING, type YouTubePlayer } from '../youtube.ts'
import { TitleArt } from './TitleArt.tsx'

// The quick view: a title's trailer and the gist of it in a popup over the list, so browsing goes on where it
// was. Clicking a poster opens it; Watch goes on to the title page. It's a history entry (router.ts), so Back,
// Escape, a click outside, or the X all close it. On a title page it opens as just the trailer.

/** What the card already knows, so the popup has a name and a picture before the details arrive. */
const known = new Map<string, TitleSummary>()
/** Trailers YouTube wouldn't play here (removed, or not allowed in other sites); not tried again this session. */
const unplayable = new Set<string>()
let returnFocus: HTMLElement | null = null

/** Opens the popup for this title. `trailerOnly`: just the trailer (from the title's own page). */
export function showPreview (t: TitleSummary, opts: { trailerOnly?: boolean } = {}) {
  known.set(`${t.type}/${t.id}`, t)
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  openPreview(`${t.type}/${t.id}${opts.trailerOnly ? '/trailer' : ''}`)
}

type Find = 'finding' | 'loading' | 'playing' | 'ended' | 'none' | 'failed'

/**
 * The trailers to try, in order: Cinemeta's, then a YouTube search when those run out (old trailers are often
 * gone from YouTube, or can't be embedded).
 */
function useTrailerPlayer (type: MediaType, id: string, detail: TitleDetail | null, host: HTMLDivElement | null) {
  const [find, setFind] = useState<Find>('finding')
  const player = useRef<YouTubePlayer | null>(null)
  const pausedMusic = useRef(false)

  useEffect(() => {
    if (!detail || !host) return
    let live = true
    const tried = new Set<string>()
    let playing: string | null = null
    let queue = (detail.trailers ?? []).slice(0, 4)
    let searched = false

    const nextId = async (): Promise<string | null> => {
      while (true) {
        const id = queue.find(x => !tried.has(x) && !unplayable.has(x))
        if (id) { tried.add(id); return id }
        if (searched) return null
        searched = true
        queue = (await api.trailerSearch(type, detail.id).catch(() => ({ ids: [] }))).ids
      }
    }

    const start = async () => {
      const first = await nextId()
      if (!live) return
      if (!first) { setFind('none'); return }
      setFind('loading')
      let YT
      try { YT = await loadYouTube() } catch { if (live) setFind('failed'); return }
      if (!live) return
      playing = first
      const el = document.createElement('div')
      host.replaceChildren(el)
      player.current = new YT.Player(el, {
        host: 'https://www.youtube-nocookie.com',
        videoId: first,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, iv_load_policy: 3, modestbranding: 1, origin: location.origin },
        events: {
          onReady: e => e.target.playVideo(),
          onStateChange: e => {
            if (!live) return
            if (e.data === YT_PLAYING) {
              setFind('playing')
              // A song playing here stops for the trailer, and goes on after it.
              const s = playerState()
              if (s.playing && !s.cast?.active) { pauseMusic(); pausedMusic.current = true }
            } else if (e.data === YT_ENDED) setFind('ended')
          },
          onError: () => {
            if (playing) unplayable.add(playing)
            void nextId().then(next => {
              if (!live) return
              playing = next
              if (next) player.current?.loadVideoById(next); else setFind('none')
            })
          },
        },
      })
    }
    void start()

    return () => {
      live = false
      player.current?.destroy()
      player.current = null
      host.replaceChildren()
      if (pausedMusic.current && !playerState().playing) toggleMusic()
      pausedMusic.current = false
    }
  }, [type, detail, host])

  const replay = () => { player.current?.playVideo() }
  return { find, replay }
}

export function Preview ({ target }: { target: string }) {
  const m = target.match(/^(movie|series)\/(tt\d+)(\/trailer)?$/)
  const type = (m?.[1] ?? 'movie') as MediaType
  const id = m?.[2] ?? ''
  const trailerOnly = Boolean(m?.[3])
  const hint = known.get(`${type}/${id}`)
  const [detail, setDetail] = useState<TitleDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const { find, replay } = useTrailerPlayer(type, id, detail, host)
  const mark = useMark(id)

  useEffect(() => {
    if (!m) { closePreview(); return }
    let live = true
    api.title(type, id).then(d => { if (live) setDetail(d) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [type, id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const d = dialog.current
    if (d && !d.open) {
      d.showModal()
      // Watch first (Enter goes to the title); just the trailer: Close. React doesn't write `autofocus`.
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
    }
    const focus = returnFocus
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }) }
  }, [])

  const name = detail?.name ?? hint?.name ?? ''
  const art = detail?.background ?? detail?.poster ?? hint?.poster
  const facts = detail ? [detail.year, detail.runtime, detail.genres.slice(0, 3).join(', ')].filter(Boolean) : []
  const note = failed ? 'Couldn’t load this title.'
    : find === 'none' ? 'No trailer found for this one.'
      : find === 'failed' ? 'YouTube didn’t load. Check the connection and try again.'
        : null

  return (
    <dialog
      ref={dialog}
      className={`preview${trailerOnly ? ' is-trailer' : ''}`}
      aria-label={name ? `${name}: trailer` : 'Trailer'}
      // Escape: the history entry goes, which closes this.
      onCancel={e => { e.preventDefault(); closePreview() }}
      onClick={e => { if (e.target === e.currentTarget) closePreview() }}
    >
      <div className="preview-card">
        <div className={`preview-media is-${find}`}>
          {art && <img className="preview-still" src={art} alt="" decoding="async" />}
          <div className="preview-player" ref={setHost} />
          {(find === 'finding' || find === 'loading') && !failed && <span className="preview-spinner" aria-label="Loading the trailer" />}
          {note && <p className="preview-note">{note}</p>}
          {find === 'ended' && (
            <button type="button" className="button preview-replay" onClick={replay}><Play aria-hidden fill="currentColor" /> Play again</button>
          )}
          <button type="button" className="round-button preview-close" aria-label="Close" data-tip="Close" data-autofocus={trailerOnly || undefined} onClick={closePreview}>
            <X aria-hidden />
          </button>
        </div>
        {!trailerOnly && (
          <div className="preview-body">
            <div className="preview-head">
              {detail ? <TitleArt className="preview-logo" name={detail.name} logo={detail.logo} /> : <h2 className="preview-name">{name}</h2>}
              {facts.length > 0 && (
                <p className="preview-facts">
                  {facts.join(' · ')}
                  {detail?.imdbRating && <> · <span className="rating"><span className="rating-label">IMDb</span> {detail.imdbRating}</span></>}
                </p>
              )}
            </div>
            <div className="preview-actions actions">
              <button type="button" className="button primary" data-autofocus onClick={() => navigate(`/title/${type}/${id}`, { replace: true })}>
                <Play aria-hidden fill="currentColor" /> Watch
              </button>
              <button type="button" className="round-button" aria-pressed={mark.inList} data-tip={mark.inList ? 'In My List' : 'My List'}
                aria-label={mark.inList ? `Remove ${name} from My List` : `Add ${name} to My List`}
                onClick={() => setTitleInList(type, id, !mark.inList)}>
                {mark.inList ? <Check aria-hidden /> : <Plus aria-hidden />}
              </button>
              <button type="button" className="round-button" aria-pressed={mark.rating === 1} data-tip={mark.rating === 1 ? 'Liked' : 'Like'}
                aria-label={`Like ${name}`} onClick={() => rateTitle(type, id, mark.rating === 1 ? 0 : 1, 'preview')}>
                <ThumbsUp aria-hidden />
              </button>
              <button type="button" className="round-button" aria-pressed={mark.rating === -1} data-tip={mark.rating === -1 ? 'Disliked' : 'Dislike'}
                aria-label={`Dislike ${name}`} onClick={() => rateTitle(type, id, mark.rating === -1 ? 0 : -1, 'preview')}>
                <ThumbsDown aria-hidden />
              </button>
            </div>
            {detail?.description && <p className="preview-desc">{detail.description}</p>}
          </div>
        )}
      </div>
    </dialog>
  )
}
