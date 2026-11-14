import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, FolderOpen, FolderPen } from 'lucide-react'
import type { StorageReport, StoredStream } from '../../../shared/storage.ts'
import { api } from '../api.ts'
import { desktop } from '../desktop.ts'
import { bytes } from '../format.ts'
import { useDocumentTitle } from '../hooks.ts'
import { onLinkClick } from '../router.ts'
import { toast } from '../toast.ts'
import { TopBar } from '../components/TopBar.tsx'

type Load = { state: 'loading' } | { state: 'ok'; r: StorageReport } | { state: 'error'; message: string }

/** Each kind of saved content has a grey of its own, the same in the meter and beside its row. */
const SHADES = { downloads: 1, streamed: 2, music: 3, trailers: 4, app: 5 } as const
type Kind = keyof typeof SHADES

const ago = (at: number): string => {
  const min = Math.round((Date.now() - at) / 60_000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/**
 * What nexttupp keeps on this computer, how much room that takes and how much is left, with a way to delete
 * any of it, one title at a time or all at once; and where downloads are saved.
 */
export function Storage () {
  useDocumentTitle('Storage')
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const refresh = useCallback(() => api.storage()
    .then(r => setLoad({ state: 'ok', r }))
    .catch(err => setLoad(prev => (prev.state === 'ok' ? prev : { state: 'error', message: (err as Error).message }))), [])
  useEffect(() => { void refresh() }, [refresh])

  /** Runs a deletion, says what it freed, and reads the disk again. */
  const free = useCallback((what: Promise<{ freed: number; skipped?: number }>, label: string) => what
    .then(({ freed, skipped }) => toast(`${label}${freed > 0 ? `: ${bytes(freed)} freed` : ''}.${skipped ? ' What’s playing now stays.' : ''}`))
    .catch(err => toast(`Couldn’t delete that. ${(err as Error).message}`))
    .finally(() => { void refresh() }), [refresh])

  return (
    <main className="account-page storage-page">
      <TopBar solid />
      <div className="account-body storage-body">
        <header className="account-head">
          <h1 className="account-title">Storage</h1>
          <p className="account-lede">What nexttupp keeps on this computer and the room it takes. Delete any of it, whenever you like.</p>
        </header>
        {load.state === 'loading' && <div aria-busy="true" className="storage-skeleton"><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line" /></div>}
        {load.state === 'error' && <p className="notice" role="alert">Couldn’t read the disk. {load.message}</p>}
        {load.state === 'ok' && <Report r={load.r} free={free} onChange={r => setLoad({ state: 'ok', r })} />}
      </div>
    </main>
  )
}

function Report ({ r, free, onChange }: {
  r: StorageReport
  free: (what: Promise<{ freed: number; skipped?: number }>, label: string) => Promise<void>
  onChange: (r: StorageReport) => void
}) {
  const ours = r.downloads.bytes + r.streamed.bytes + r.music.bytes + r.trailers.bytes + r.app.bytes
  const cache = r.streamed.bytes + r.music.bytes + r.trailers.bytes
  const clearCache = () => free(
    Promise.all([api.clearStreamed(), api.clearMusic(), api.clearTrailers()])
      .then(all => ({ freed: all.reduce((n, x) => n + x.freed, 0), skipped: all[0].skipped })),
    'Cache cleared')

  return (
    <>
      <DiskMeter r={r} ours={ours} />

      <section className="storage-section" aria-labelledby="kept-h">
        <div className="storage-section-head">
          <h2 id="kept-h" className="section-title">On this computer</h2>
          {cache > 0 && <Confirm label="Clear cache" ask={`Delete ${bytes(cache)} of cache? Downloads stay.`} yes="Clear" onYes={clearCache} />}
        </div>

        <ul className="store-groups">
          <Group kind="downloads" title="Downloads" bytes={r.downloads.bytes}
            note={r.downloads.items.length
              ? <>{r.downloads.items.length} {r.downloads.items.length === 1 ? 'title' : 'titles'} you kept to watch later. <a className="text-button inline" href="/downloads" onClick={onLinkClick}>Open Downloads</a></>
              : 'Nothing kept to watch later.'}
            action={r.downloads.items.length > 1 && <Confirm label="Delete all" ask={`Delete all ${r.downloads.items.length} downloads?`} yes="Delete" onYes={() => free(api.deleteAllDownloads(), 'Downloads deleted')} />}
          >
            {r.downloads.items.map(d => (
              <Item key={d.id} title={d.title} meta={[bytes(d.bytes), d.paused ? 'paused' : null]}>
                <Confirm label="Delete" ask="Delete?" yes="Delete" small onYes={() => free(api.unkeep(d.id, true).then(() => ({ freed: d.bytes })), `Deleted ${d.title}`)} />
              </Item>
            ))}
          </Group>

          <Group kind="streamed" title="Watched and streamed" bytes={r.streamed.bytes}
            note="What you played without downloading. Kept for a day so it starts at once if you go back to it, then deleted."
            action={r.streamed.items.some(s => !s.inUse) && <Confirm label="Clear" ask={`Delete ${bytes(r.streamed.bytes)}?`} yes="Clear" onYes={() => free(api.clearStreamed(), 'Cleared')} />}
          >
            {r.streamed.items.map(s => <StreamItem key={s.infoHash} s={s} free={free} />)}
          </Group>

          <Group kind="music" title="Music" bytes={r.music.bytes}
            note={r.music.songs ? `${r.music.songs.toLocaleString()} ${r.music.songs === 1 ? 'song' : 'songs'} you played, kept so they play again instantly. The oldest go after 3 GB.` : 'Songs you play are kept here so they play again instantly.'}
            action={r.music.bytes > 0 && <Confirm label="Clear" ask={`Delete ${bytes(r.music.bytes)} of music?`} yes="Clear" onYes={() => free(api.clearMusic(), 'Music cleared')} />}
          />

          <Group kind="trailers" title="Trailers" bytes={r.trailers.bytes}
            note={`${r.trailers.count ? `${r.trailers.count} ${r.trailers.count === 1 ? 'trailer' : 'trailers'}` : 'Trailers'} that play behind titles. The oldest go after 1 GB.`}
            action={r.trailers.bytes > 0 && <Confirm label="Clear" ask={`Delete ${bytes(r.trailers.bytes)} of trailers?`} yes="Clear" onYes={() => free(api.clearTrailers(), 'Trailers cleared')} />}
          />

          <Group kind="app" title="nexttupp" bytes={r.app.bytes} note="Profiles, recommendations and helpers. nexttupp needs these to run." />
        </ul>
      </section>

      <Folder r={r} onChange={onChange} />
    </>
  )
}

/** The disk the downloads go to: how full it is, and how much of that is nexttupp's. */
function DiskMeter ({ r, ours }: { r: StorageReport; ours: number }) {
  const d = r.disk
  if (!d || d.total <= 0) return <p className="account-note">nexttupp uses {bytes(ours)} on this computer.</p>
  const used = d.total - d.free
  const parts: Array<[Kind, number]> = [['downloads', r.downloads.bytes], ['streamed', r.streamed.bytes], ['music', r.music.bytes], ['trailers', r.trailers.bytes], ['app', r.app.bytes]]
  const pct = (n: number) => `${(Math.max(0, n) / d.total) * 100}%`
  return (
    <section className="disk" aria-label="Disk space">
      <p className="disk-free"><strong>{bytes(d.free)} free</strong> <span className="quiet">of {bytes(d.total)}</span></p>
      <div className="disk-meter" role="img" aria-label={`${bytes(d.free)} free of ${bytes(d.total)}. nexttupp uses ${bytes(ours)}; other files use ${bytes(Math.max(0, used - ours))}.`}>
        {parts.filter(([, n]) => n > 0).map(([k, n]) => <span key={k} className="disk-seg" data-shade={SHADES[k]} style={{ width: pct(n) }} />)}
        <span className="disk-seg is-other" style={{ width: pct(used - ours) }} />
      </div>
      <p className="disk-legend">
        <span><span className="swatch" data-shade="1" aria-hidden />nexttupp {bytes(ours)}</span>
        <span><span className="swatch is-other" aria-hidden />Other files {bytes(Math.max(0, used - ours))}</span>
        <span><span className="swatch is-free" aria-hidden />Free {bytes(d.free)}</span>
      </p>
      {r.dataDisk && <p className="fine-print">Music, trailers and nexttupp’s own files are on another disk, with {bytes(r.dataDisk.free)} free of {bytes(r.dataDisk.total)}.</p>}
    </section>
  )
}

function Group ({ kind, title, bytes: size, note, action, children }: {
  kind: Kind; title: string; bytes: number; note: ReactNode; action?: ReactNode; children?: ReactNode[]
}) {
  const list = (children ?? []).filter(Boolean)
  const [open, setOpen] = useState(false)
  const head = (
    <>
      <span className="swatch" data-shade={SHADES[kind]} aria-hidden />
      <span className="store-name">{title}</span>
      <span className={`store-size${size > 0 ? '' : ' is-empty'}`}>{size > 0 ? bytes(size) : 'Empty'}</span>
    </>
  )
  return (
    <li className="store-group">
      {list.length > 0
        ? (
          <button type="button" className="store-head is-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {head}<ChevronDown className="store-chevron" aria-hidden />
          </button>
          )
        : <div className="store-head">{head}</div>}
      <div className="store-foot">
        <p className="store-note">{note}</p>
        {action && <div className="store-action">{action}</div>}
      </div>
      {open && list.length > 0 && <ul className="store-items">{list}</ul>}
    </li>
  )
}

function Item ({ title, meta, children }: { title: string; meta: Array<string | null>; children?: ReactNode }) {
  return (
    <li className="store-item">
      <span className="store-item-text">
        <span className="store-item-title">{title}</span>
        <span className="store-item-meta">{meta.filter(Boolean).join(' · ')}</span>
      </span>
      {children}
    </li>
  )
}

function StreamItem ({ s, free }: { s: StoredStream; free: (what: Promise<{ freed: number }>, label: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Item title={s.title} meta={[bytes(s.bytes), s.inUse ? 'playing now' : s.playedAt ? `played ${ago(s.playedAt)}` : null]}>
      <button type="button" className="chip" disabled={s.inUse || busy} onClick={() => { setBusy(true); void free(api.deleteStreamed(s.infoHash), `Deleted ${s.title}`) }}>
        Delete
      </button>
    </Item>
  )
}

/** A button that asks once, in place, before it deletes. */
function Confirm ({ label, ask, yes, onYes, small }: { label: string; ask: string; yes: string; onYes: () => Promise<void> | void; small?: boolean }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!asking) return <button type="button" className="chip" onClick={() => setAsking(true)}>{label}</button>
  return (
    <span className={`confirm${small ? ' is-small' : ''}`} role="group" aria-label={ask}>
      {!small && <span className="confirm-ask">{ask}</span>}
      <button type="button" className="chip danger" disabled={busy} autoFocus onClick={() => { setBusy(true); void Promise.resolve(onYes()).finally(() => { setBusy(false); setAsking(false) }) }}>{yes}</button>
      <button type="button" className="chip" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
    </span>
  )
}

/** Where new downloads are saved, and the way to choose another folder (on the computer itself). */
function Folder ({ r, onChange }: { r: StorageReport; onChange: (r: StorageReport) => void }) {
  const [editing, setEditing] = useState(false)
  const [path, setPath] = useState(r.folder.path)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = (to: string) => {
    setBusy(true)
    setError(null)
    api.setDownloadFolder(to)
      .then(next => { onChange(next); setEditing(false); toast(`New downloads go to ${next.folder.path}.`) })
      .catch(err => setError((err as Error).message))
      .finally(() => setBusy(false))
  }
  const change = () => {
    if (desktop?.chooseFolder) { void desktop.chooseFolder(r.folder.path).then(p => { if (p) save(p) }); return }
    setPath(r.folder.path)
    setEditing(true)
  }
  const open = desktop?.openFolder ? () => { void desktop!.openFolder!(r.folder.path).then(ok => { if (!ok) toast('Couldn’t open the folder.') }) } : null

  return (
    <section className="storage-section" aria-labelledby="folder-h">
      <h2 id="folder-h" className="section-title">Download folder</h2>
      <p className="folder-path">{r.folder.path}</p>
      {editing
        ? (
          <form className="folder-form" onSubmit={e => { e.preventDefault(); save(path) }}>
            <label className="field">
              <span className="field-label">Full path of a folder</span>
              <input value={path} onChange={e => setPath(e.target.value)} spellCheck={false} autoFocus autoCapitalize="off" autoCorrect="off" />
            </label>
            <div className="actions">
              <button type="submit" className="chip" disabled={busy || !path.trim()}>Save downloads here</button>
              <button type="button" className="chip" onClick={() => { setEditing(false); setError(null) }}>Cancel</button>
            </div>
          </form>
          )
        : r.folder.canChange && (
          <div className="actions">
            {open && <button type="button" className="chip" onClick={open}><FolderOpen aria-hidden />Open</button>}
            <button type="button" className="chip" disabled={busy} onClick={change}><FolderPen aria-hidden />Change</button>
            {!r.folder.isDefault && <button type="button" className="text-button" disabled={busy} onClick={() => save('')}>Use the default folder</button>}
          </div>
          )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="account-note">
        {r.folder.canChange
          ? 'New downloads go here. What’s already downloaded stays where it is until it’s deleted.'
          : 'Change it on the computer that runs nexttupp.'}
      </p>
      {r.folder.older.length > 0 && <p className="fine-print">Earlier downloads are still in {r.folder.older.join(', ')}.</p>}
    </section>
  )
}
