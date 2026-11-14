import { Fragment, StrictMode, useEffect, useLayoutEffect, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './music/music.css'
import './trailer.css'
import { loadProfiles, useProfiles } from './profiles.ts'
import { restoreScroll, useLocation } from './router.ts'
import { PageActive } from './hooks.ts'
import { Account } from './pages/Account.tsx'
import { DownloadsPage } from './pages/DownloadsPage.tsx'
import { MyList } from './pages/MyList.tsx'
import { Storage } from './pages/Storage.tsx'
import { Ai } from './pages/Ai.tsx'
import { Home } from './pages/Home.tsx'
import { Profiles } from './pages/Profiles.tsx'
import { Taste } from './pages/Taste.tsx'
import { Title } from './pages/Title.tsx'
import { Watch } from './pages/Watch.tsx'
import { Preview } from './components/Preview.tsx'
import { Toaster } from './components/Toaster.tsx'
import { UpdateBanner } from './components/UpdateBanner.tsx'
import { Music } from './pages/Music.tsx'
import { MusicCollection } from './pages/MusicCollection.tsx'
import { MiniPlayer, NowPlaying } from './music/NowPlaying.tsx'

/** The page for an address. */
function page (path: string, query: URLSearchParams): ReactElement {
  const title = path.match(/^\/title\/(movie|series)\/(tt\d+)$/)
  if (title) return <Title key={title[2]} type={title[1] as 'movie' | 'series'} id={title[2]} season={query.get('season')} episode={query.get('ep') ?? query.get('play')} />
  if (path === '/watch') return <Watch key={query.toString()} query={query} />
  if (path === '/taste') return <Taste />
  if (path === '/account') return <Account />
  if (path === '/storage') return <Storage />
  if (path === '/list') return <MyList />
  if (path === '/downloads') return <DownloadsPage />
  if (path === '/ai') return <Ai />
  if (path === '/profiles') return <Profiles mode="manage" />
  if (path === '/music') return <Music initialQuery={query.get('q') ?? ''} />
  const music = path.match(/^\/music\/(mix|album|artist)\/([a-z0-9]{1,40})$/)
  if (music) return <MusicCollection key={path} kind={music[1] as 'mix' | 'album' | 'artist'} id={music[2]} />
  if (path === '/films' || path === '/series') return <Home key={path} initialQuery={query.get('q') ?? ''} tab={path === '/films' ? 'movie' : 'series'} />
  return <Home key="/" initialQuery={query.get('q') ?? ''} />
}

/** Pages worth keeping: long lists that are scrolled through and then left for a title or an artist. */
const isList = (path: string) => ['/', '/films', '/series', '/music', '/list', '/downloads'].includes(path)
const KEEP = 3

interface Kept { key: string; el: ReactElement }

/**
 * The page on screen. List pages stay mounted, hidden, after they're left (the last few, by history entry),
 * so Back shows the same rows, loaded and scrolled as they were, instead of starting again.
 */
function Pages () {
  const { path, query, key, preview } = useLocation()
  const [kept, setKept] = useState<Kept[]>([])
  const list = isList(path)
  if (list && !kept.some(k => k.key === key)) setKept([...kept, { key, el: page(path, query) }].slice(-KEEP))

  // After Back or Forward, the page's scroll comes back once it's on screen.
  useLayoutEffect(() => { restoreScroll() }, [key])

  return (
    <>
      {kept.map(k => (
        <PageActive.Provider key={k.key} value={k.key === key}>
          <div className={k.key === key ? 'page' : 'page page-kept'} inert={k.key !== key}>{k.el}</div>
        </PageActive.Provider>
      ))}
      {!list && <div className="page">{page(path, query)}</div>}
      {preview && <Preview key={preview} target={preview} />}
    </>
  )
}

function App () {
  const profiles = useProfiles()
  useEffect(() => { void loadProfiles() }, [])

  // Nothing is fetched for a profile until we know who's watching.
  if (profiles.status === 'loading') return <div className="boot" aria-busy="true" />
  if (profiles.status === 'ready' && profiles.picking) return <><Profiles mode="pick" /><Toaster /></>

  // Switching profile remounts the page, so every screen refetches as the new profile.
  const key = profiles.status === 'ready' ? profiles.active?.id ?? 'none' : 'offline'
  return (
    <>
      <Fragment key={key}><Pages /></Fragment>
      <MiniPlayer />
      <NowPlaying />
      <UpdateBanner />
      <Toaster />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
