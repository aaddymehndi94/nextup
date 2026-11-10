import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import '@fontsource-variable/geist'
import './styles.css'
import { useLocation } from './router.ts'
import { Home } from './pages/Home.tsx'
import { Title } from './pages/Title.tsx'
import { Watch } from './pages/Watch.tsx'

function App () {
  const { path, query } = useLocation()
  const title = path.match(/^\/title\/(movie|series)\/(tt\d+)$/)
  if (title) return <Title key={title[2]} type={title[1] as 'movie' | 'series'} id={title[2]} season={query.get('season')} />
  if (path === '/watch') return <Watch key={query.toString()} query={query} />
  return <Home initialQuery={query.get('q') ?? ''} />
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
