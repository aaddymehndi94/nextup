import { useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Download, Play } from 'lucide-react'
import type { HealthResponse, Source } from '../../../shared/types.ts'
import { bytes, languageName, RES_LABEL } from '../format.ts'

type Sort = 'best' | 'seeders' | 'small' | 'large'
const FILTERS = ['all', '2160p', '1080p', '720p', '480p'] as const

function seedsOf (s: Source, health: HealthResponse) {
  const live = health[s.infoHash]
  return { seeders: live?.seeders ?? s.seeders ?? 0, leechers: live?.leechers ?? s.leechers, live: Boolean(live) }
}

function healthClass (seeders: number) {
  if (seeders >= 30) return 'good'
  if (seeders >= 5) return 'fair'
  return 'poor'
}

/** Release names are long dotted tokens; offer line breaks after separators so they wrap at word-like joints. */
function breakable (name: string) {
  return name.split(/(?<=[._\-\])])/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]))
}

function tags (s: Source): string[] {
  const r = s.release
  const out: string[] = []
  if (r.source && r.source !== 'CAM') out.push(r.source)
  if (r.videoCodec) out.push(r.videoCodec === 'hevc' ? 'HEVC' : r.videoCodec === 'h264' ? 'H.264' : r.videoCodec.toUpperCase())
  if (r.tenBit) out.push('10-bit')
  out.push(...r.hdr)
  const audio = r.audio.filter(a => a !== 'atmos').map(a => ({ eac3: 'DD+', ac3: 'DD', truehd: 'TrueHD', dts: 'DTS' } as Record<string, string>)[a] ?? a.toUpperCase())
  if (r.audio.includes('atmos')) audio.push('Atmos')
  out.push(...audio)
  return out
}

export function SourceList ({ sources, health, onPick, onDownload, isSaved }: {
  sources: Source[]
  health: HealthResponse
  onPick: (s: Source) => void
  onDownload: (s: Source) => void
  isSaved: (s: Source) => boolean
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [sort, setSort] = useState<Sort>('best')
  const [showAll, setShowAll] = useState(false)

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sources.length }
    for (const s of sources) c[s.release.resolution] = (c[s.release.resolution] ?? 0) + 1
    return c
  }, [sources])

  const visible = useMemo(() => {
    const list = sources.filter(s => filter === 'all' || s.release.resolution === filter)
    const sorted = [...list]
    if (sort === 'seeders') sorted.sort((a, b) => seedsOf(b, health).seeders - seedsOf(a, health).seeders)
    if (sort === 'small') sorted.sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity))
    if (sort === 'large') sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
    return sorted
  }, [sources, filter, sort, health])

  const shown = showAll ? visible : visible.slice(0, 8)
  const liveCount = Object.keys(health).length

  return (
    <div className="source-list">
      <div className="source-controls">
        <div className="chips" role="group" aria-label="Filter by quality">
          {FILTERS.filter(f => f === 'all' || counts[f]).map(f => (
            <button key={f} className={filter === f ? 'chip active' : 'chip'} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : RES_LABEL[f]} <span className="chip-count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <label className="sort">
          <span>Sort</span>
          <span className="select">
            <select value={sort} onChange={e => setSort(e.target.value as Sort)}>
              <option value="best">Best match</option>
              <option value="seeders">Most seeders</option>
              <option value="small">Smallest</option>
              <option value="large">Largest</option>
            </select>
            <ChevronDown aria-hidden />
          </span>
        </label>
      </div>
      <p className="source-legend">
        <span className={`live-dot${liveCount > 0 ? ' is-live' : ''}`} aria-hidden />
        {liveCount > 0 ? <>Seeders and peers are live from trackers ({liveCount} checked).</> : <>Seeders as reported by indexes. Checking live swarm…</>}
      </p>
      <div className="sources-header" aria-hidden>
        <span>Quality</span>
        <span>Release</span>
        <span className="num">Size</span>
        <span className="num">Seeds</span>
        <span className="num">Peers</span>
        <span>Indexer</span>
      </div>
      <ol className="sources-table">
        {shown.map((s, i) => {
          const { seeders, leechers, live } = seedsOf(s, health)
          const recommended = sort === 'best' && filter === 'all' && i === 0
          const langs = s.languages.map(languageName)
          const facts = tags(s)
          const kept = isSaved(s)
          return (
            <li key={s.infoHash} className="source-row">
              <button className={`source${recommended ? ' recommended' : ''}`} onClick={() => onPick(s)} title={s.title}>
                <span className={`res res-${s.release.resolution}`}>{RES_LABEL[s.release.resolution]}</span>
                <span className="source-main">
                  <span className="source-title">{breakable(s.fileName && s.fileName !== s.title ? s.fileName : s.title)}</span>
                  <span className="source-sub">
                    {recommended && <span className="badge">Recommended</span>}
                    {facts.length > 0 && <span className="source-facts">{facts.join(' · ')}</span>}
                    {langs.length > 0 && <span className="source-lang">{langs.join(' · ')}</span>}
                    {s.notes.filter(n => !/healthy|seeders/i.test(n)).map(n => {
                      const good = /conversion/.test(n)
                      return (
                        <span key={n} className={good ? 'note good' : 'note warn'}>
                          {good ? <Check aria-hidden /> : <AlertTriangle aria-hidden />}{n}
                        </span>
                      )
                    })}
                  </span>
                </span>
                <span className="source-stats">
                  <span className="stat size">{bytes(s.sizeBytes)}</span>
                  <span className={`stat seeds ${healthClass(seeders)}`} title={live ? 'Live tracker count' : 'Indexer count (may be stale)'}>
                    <span className="dot" aria-hidden /><span className="num">{seeders}</span><span className="unit">{seeders === 1 ? ' seed' : ' seeds'}</span>
                  </span>
                  <span className="stat peers">{leechers !== undefined ? <>{leechers}<span className="unit">{leechers === 1 ? ' peer' : ' peers'}</span></> : <span className="unit">—</span>}</span>
                  <span className="stat provider">{s.providers.join(', ')}</span>
                </span>
                <span className="source-go" aria-hidden><Play fill="currentColor" /></span>
              </button>
              {/* A sibling, not inside the row's button: buttons can't nest. */}
              <button type="button" className={`source-save${kept ? ' is-saved' : ''}`} onClick={() => onDownload(s)} aria-label={kept ? `Downloading ${s.title}` : `Download ${s.title} to watch later`} data-tip={kept ? 'Downloading' : 'Download'}>
                {kept ? <Check aria-hidden /> : <Download aria-hidden />}
              </button>
            </li>
          )
        })}
      </ol>
      {visible.length > shown.length && (
        <button className="button secondary show-more" onClick={() => setShowAll(true)}>Show all {visible.length} sources</button>
      )}
    </div>
  )
}
