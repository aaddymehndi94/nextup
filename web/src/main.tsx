import { Fragment, StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { loadProfiles, useProfiles } from './profiles.ts'
import { useLocation } from './router.ts'
import { Account } from './pages/Account.tsx'
import { Home } from './pages/Home.tsx'
import { Profiles } from './pages/Profiles.tsx'
import { Taste } from './pages/Taste.tsx'
import { Title } from './pages/Title.tsx'
import { Watch } from './pages/Watch.tsx'
import { Toaster } from './components/Toaster.tsx'

function Route () {
  const { path, query } = useLocation()
  const title = path.match(/^\/title\/(movie|series)\/(tt\d+)$/)
  if (title) return <Title key={title[2]} type={title[1] as 'movie' | 'series'} id={title[2]} season={query.get('season')} play={query.get('play')} />
  if (path === '/watch') return <Watch key={query.toString()} query={query} />
  if (path === '/taste') return <Taste />
  if (path === '/account') return <Account code={query.get('code')} />
  if (path === '/profiles') return <Profiles mode="manage" />
  if (path === '/films' || path === '/series') return <Home key={path} initialQuery={query.get('q') ?? ''} tab={path === '/films' ? 'movie' : 'series'} />
  return <Home key="/" initialQuery={query.get('q') ?? ''} />
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
      <Fragment key={key}><Route /></Fragment>
      <Toaster />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
