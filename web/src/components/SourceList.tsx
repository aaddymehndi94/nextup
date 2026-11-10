import { useMemo, useState } from 'react'
import type { HealthResponse, Source } from '../../../shared/types.ts'
import { bytes, LANG_NAME, RES_LABEL } from '../format.ts'

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

export function SourceList ({ sources, health, onPick }: { sources: Source[]; health: HealthResponse; onPick: (s: Source) => void }) {
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

  const shown = showAll ? visible : visible.slice(0, 25)
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
          <select value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="best">Best match</option>
            <option value="seeders">Most seeders</option>
            <option value="small">Smallest</option>
            <option value="large">Largest</option>
          </select>
        </label>
      </div>
      <p className="muted small source-legend">
        {liveCount > 0 ? <>Seeders and peers are live from trackers ({liveCount} checked).</> : <>Seeders as reported by indexes. Checking live swarm…</>}
      </p>
      <ol className="sources-table">
        {shown.map((s, i) => {
          const { seeders, leechers, live } = seedsOf(s, health)
          const recommended = sort === 'best' && filter === 'all' && i === 0
          const langs = s.languages.map(l => LANG_NAME[l] ?? l.toUpperCase())
          return (
            <li key={s.infoHash}>
              <button className={`source${recommended ? ' recommended' : ''}`} onClick={() => onPick(s)} title={s.title}>
                <span className={`res res-${s.release.resolution}`}>{RES_LABEL[s.release.resolution]}</span>
                <span className="source-main">
                  <span className="source-title">{s.fileName && s.fileName !== s.title ? s.fileName : s.title}</span>
                  <span className="source-sub">
                    {recommended && <span className="badge">Recommended</span>}
                    {tags(s).map(t => <span key={t} className="tag">{t}</span>)}
                    {langs.length > 0 && <span className="tag lang">{langs.join(' · ')}</span>}
                    {s.notes.filter(n => !/healthy|seeders/i.test(n)).map(n => (
                      <span key={n} className={/conversion/.test(n) ? 'note good' : 'note warn'}>{n}</span>
                    ))}
                  </span>
                </span>
                <span className="source-stats">
                  <span className="stat size">{bytes(s.sizeBytes)}</span>
                  <span className={`stat seeds ${healthClass(seeders)}`} title={live ? 'Live tracker count' : 'Indexer count (may be stale)'}>
                    <span className="dot" aria-hidden />{seeders}<span className="unit"> seeds</span>
                  </span>
                  <span className="stat peers">{leechers !== undefined ? <>{leechers}<span className="unit"> peers</span></> : '—'}</span>
                  <span className="stat provider">{s.providers.join(', ')}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {visible.length > shown.length && (
        <button className="button ghost show-more" onClick={() => setShowAll(true)}>Show all {visible.length} sources</button>
      )}
    </div>
  )
}
