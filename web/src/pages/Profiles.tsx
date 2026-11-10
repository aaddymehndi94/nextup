import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { Profile } from '../../../shared/types.ts'
import { chooseProfile, createProfile, deleteProfile, renameProfile, useProfiles } from '../profiles.ts'
import { useDocumentTitle } from '../hooks.ts'
import { navigate } from '../router.ts'
import { Avatar } from '../components/Avatar.tsx'
import { Wordmark } from '../components/Wordmark.tsx'

const MAX_PROFILES = 12

type Editing = { kind: 'add' } | { kind: 'edit'; profile: Profile } | null

/**
 * "Who's watching?" (mode "pick", shown before anything else when there is more than one profile) and
 * "Manage profiles" (add, rename, delete). The same screen, so managing never loses your place.
 */
export function Profiles ({ mode: startMode }: { mode: 'pick' | 'manage' }) {
  const state = useProfiles()
  const [mode, setMode] = useState(startMode)
  const [editing, setEditing] = useState<Editing>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const grid = useRef<HTMLUListElement>(null)
  useDocumentTitle(mode === 'pick' ? 'Who’s watching?' : 'Manage profiles')

  // Land on the profile last used here (or the one just added or edited), so a remote needs one press.
  const ready = state.status === 'ready'
  const target = focusId ?? (ready ? state.active?.id ?? null : null)
  useEffect(() => {
    if (editing || !ready) return
    const el = grid.current?.querySelector<HTMLElement>(target ? `[data-profile="${target}"]` : '[data-profile]')
    el?.focus({ preventScroll: true })
  }, [editing, ready, target, mode])

  if (state.status === 'loading') return <main className="profiles-page" aria-busy="true" />
  if (state.status === 'error') {
    return (
      <main className="profiles-page">
        <div className="page-notice"><p className="empty-title">Couldn’t load profiles</p><p className="notice">{state.message}</p></div>
      </main>
    )
  }

  const { profiles } = state
  const finish = () => {
    if (startMode === 'manage') {
      if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back(); else navigate('/')
    } else {
      setMode('pick')
    }
  }

  return (
    <main className="profiles-page">
      <header className="profiles-top"><Wordmark /></header>
      <section className="profiles-stage" aria-labelledby="profiles-h">
        {editing
          ? (
            <ProfileForm
              key={editing.kind === 'edit' ? editing.profile.id : 'add'}
              profile={editing.kind === 'edit' ? editing.profile : undefined}
              count={profiles.length}
              onDone={id => { setEditing(null); if (id) setFocusId(id) }}
            />
            )
          : (
            <>
              <h1 id="profiles-h" className="profiles-title">{mode === 'pick' ? 'Who’s watching?' : 'Manage profiles'}</h1>
              {mode === 'pick' && state.gone && <p className="profiles-note" role="status">That profile was deleted. Choose who’s watching.</p>}
              {mode === 'manage' && <p className="profiles-note">Each profile has its own likes, My List and Continue watching.</p>}
              <ul className="profile-grid" ref={grid}>
                {profiles.map(p => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="profile-tile"
                      data-profile={p.id}
                      aria-label={mode === 'pick' ? p.name : `Edit ${p.name}`}
                      onClick={() => (mode === 'pick' ? chooseProfile(p.id) : setEditing({ kind: 'edit', profile: p }))}
                    >
                      <span className="profile-art">
                        <Avatar profile={p} className="large" />
                        {mode === 'manage' && <span className="profile-edit" aria-hidden><Pencil /></span>}
                      </span>
                      <span className="profile-name">{p.name}</span>
                    </button>
                  </li>
                ))}
                {profiles.length < MAX_PROFILES && (
                  <li>
                    <button type="button" className="profile-tile is-add" onClick={() => setEditing({ kind: 'add' })}>
                      <span className="profile-art"><span className="avatar large add" aria-hidden><Plus /></span></span>
                      <span className="profile-name">Add profile</span>
                    </button>
                  </li>
                )}
              </ul>
              <div className="profiles-actions">
                {mode === 'pick'
                  ? <button type="button" className="button secondary" onClick={() => setMode('manage')}><Pencil aria-hidden />Manage profiles</button>
                  : <button type="button" className="button primary" onClick={finish}>Done</button>}
              </div>
            </>
            )}
      </section>
    </main>
  )
}

function ProfileForm ({ profile, count, onDone }: { profile?: Profile; count: number; onDone: (id?: string) => void }) {
  const [name, setName] = useState(profile?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const only = count <= 1
  const trimmed = name.trim()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const p = profile ? await renameProfile(profile.id, trimmed) : await createProfile(trimmed)
      onDone(p.id)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!profile) return
    setBusy(true)
    setError(null)
    try {
      await deleteProfile(profile.id)
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setConfirming(false)
      setBusy(false)
    }
  }

  return (
    <form className="profile-form" onSubmit={submit} aria-labelledby="profile-form-h">
      <h1 id="profile-form-h" className="profiles-title">{profile ? 'Edit profile' : 'Add a profile'}</h1>
      {!profile && <p className="profiles-note">For someone else who watches here. They get their own likes, My List and picks.</p>}
      <div className="profile-form-row">
        <Avatar profile={{ id: profile?.id ?? 'new', name: trimmed || '+', avatar: profile?.avatar }} className="large" />
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={40} autoFocus autoComplete="off" spellCheck={false} enterKeyHint="done" />
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button type="submit" className="button primary" disabled={!trimmed || busy || (profile && trimmed === profile.name)}>{profile ? 'Save' : 'Add profile'}</button>
        <button type="button" className="button secondary" onClick={() => onDone(profile?.id)}>Cancel</button>
      </div>
      {profile && (
        <div className="profile-danger">
          {confirming
            ? (
              <div className="confirm" role="group" aria-label={`Delete ${profile.name}?`}>
                <p>Delete {profile.name}? Their likes, My List and watch history go with it.</p>
                <span className="confirm-actions">
                  <button type="button" className="chip danger" onClick={remove} disabled={busy} autoFocus>Delete</button>
                  <button type="button" className="chip" onClick={() => setConfirming(false)}>Keep</button>
                </span>
              </div>
              )
            : (
              <button type="button" className="text-button" disabled={only} onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden />Delete profile
              </button>
              )}
          {only && <p className="fine-print">This is the only profile, so it can’t be deleted.</p>}
        </div>
      )}
    </form>
  )
}
