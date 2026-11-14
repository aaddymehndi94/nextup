import { useEffect, useId, useRef, useState } from 'react'
import { Check, CircleArrowUp, CircleUserRound, HardDrive, Laptop, Pencil, RefreshCw, SlidersHorizontal, Smartphone, Sparkles, VenetianMask } from 'lucide-react'
import { desktop, useDesktopUpdate } from '../desktop.ts'
import { setPrivate, usePrivate } from '../private.ts'
import { chooseProfile, useProfiles } from '../profiles.ts'
import { navigate } from '../router.ts'
import { toast } from '../toast.ts'
import { Avatar } from './Avatar.tsx'

/** Opened on the computer that runs nexttupp, rather than on a phone over the home Wi-Fi. */
const onComputer = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
/** The phone app's computer list, without connecting by itself (server/lan/routes.ts has the base URL). */
const SWITCH_COMPUTER = 'https://nexttupp.com/watch?choose'

/**
 * The active profile's avatar in the masthead. Opens a small menu: switch profile, private mode, see
 * "Your taste", manage profiles, the optional account (sign-in and sync) and storage. On the computer it also
 * points the way to the phone app; on a phone it leads back to the list of computers. Arrow keys move through it
 * (remote friendly); Escape closes it. While private mode is on, a "Private" label sits beside the avatar.
 */
export function ProfileMenu () {
  const profiles = useProfiles()
  const priv = usePrivate()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const update = useDesktopUpdate()

  useEffect(() => {
    if (!open) return
    const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    items()[0]?.focus()
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
      const list = items()
      if (!list.length) return
      e.preventDefault()
      const i = list.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length
      list[next].focus()
    }
    document.addEventListener('pointerdown', onDown)
    root.current?.addEventListener('keydown', onKey)
    const el = root.current
    return () => { document.removeEventListener('pointerdown', onDown); el?.removeEventListener('keydown', onKey) }
  }, [open])

  if (profiles.status !== 'ready' || !profiles.active) return null
  const { active } = profiles
  const go = (to: string) => { setOpen(false); navigate(to) }
  const checkForUpdate = () => {
    setOpen(false)
    toast('Checking for a newer nexttupp…')
    desktop?.checkForUpdate()
      .then(u => toast(u ? `nexttupp ${u.version} is out.${u.state === 'downloading' ? ' It’s downloading.' : ''}` : 'You have the latest nexttupp.'))
      .catch(() => toast('Couldn’t check for updates. Try again later.'))
  }
  const togglePrivate = () => {
    setOpen(false)
    setPrivate(!priv)
    toast(priv ? 'Private mode is off.' : 'Private mode is on. Nothing you watch or do in this window is saved, and it ends when you close it.')
  }

  return (
    <div className="profile-menu" ref={root}>
      {priv && (
        <button type="button" className="private-pill" onClick={() => setOpen(o => !o)} aria-label="Private mode is on. Open the menu to turn it off.">
          <VenetianMask aria-hidden /><span>Private</span>
        </button>
      )}
      <button
        ref={button}
        type="button"
        className="avatar-button"
        aria-label={`Profile: ${active.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(o => !o)}
      >
        <Avatar profile={active} />
        {update && <span className="avatar-dot" aria-hidden />}
      </button>
      {open && (
        <div className="menu" role="menu" id={menuId} aria-label="Profiles">
          <div className="menu-group" role="group" aria-label="Switch profile">
            {profiles.profiles.map(p => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="menu-item"
                aria-current={p.id === active.id || undefined}
                onClick={() => { setOpen(false); if (p.id !== active.id) chooseProfile(p.id) }}
              >
                <Avatar profile={p} className="small" />
                <span className="menu-label">{p.name}</span>
                {p.id === active.id && <Check className="menu-check" aria-hidden />}
              </button>
            ))}
          </div>
          <div className="menu-rule" role="separator" />
          <button type="button" role="menuitemcheckbox" aria-checked={priv} className="menu-item" onClick={togglePrivate}>
            <VenetianMask className="menu-icon" aria-hidden />
            <span className="menu-label">Private mode</span>
            <span className={`menu-switch${priv ? ' is-on' : ''}`} aria-hidden />
          </button>
          <div className="menu-rule" role="separator" />
          <a href="/taste" role="menuitem" className="menu-item" onClick={e => { e.preventDefault(); go('/taste') }}>
            <SlidersHorizontal className="menu-icon" aria-hidden />
            <span className="menu-label">Your taste</span>
          </a>
          <a href="/ai" role="menuitem" className="menu-item" onClick={e => { e.preventDefault(); go('/ai') }}>
            <Sparkles className="menu-icon" aria-hidden />
            <span className="menu-label">AI settings</span>
          </a>
          <a href="/profiles" role="menuitem" className="menu-item" onClick={e => { e.preventDefault(); go('/profiles') }}>
            <Pencil className="menu-icon" aria-hidden />
            <span className="menu-label">Manage profiles</span>
          </a>
          <a href="/account" role="menuitem" className="menu-item" onClick={e => { e.preventDefault(); go('/account') }}>
            <CircleUserRound className="menu-icon" aria-hidden />
            <span className="menu-label">Account</span>
          </a>
          <a href="/storage" role="menuitem" className="menu-item" onClick={e => { e.preventDefault(); go('/storage') }}>
            <HardDrive className="menu-icon" aria-hidden />
            <span className="menu-label">Storage</span>
          </a>
          {onComputer
            ? (
              <a href="/account#phones" role="menuitem" className="menu-item" onClick={e => { e.preventDefault(); go('/account#phones') }}>
                <Smartphone className="menu-icon" aria-hidden />
                <span className="menu-label">Watch on your phone</span>
              </a>
              )
            : (
              <a href={SWITCH_COMPUTER} role="menuitem" className="menu-item">
                <Laptop className="menu-icon" aria-hidden />
                <span className="menu-label">Switch computer</span>
              </a>
              )}
          {desktop && (update && update.state !== 'failed'
            ? (
              <button type="button" role="menuitem" className="menu-item" disabled={update.state === 'installing'} onClick={() => { setOpen(false); desktop!.installUpdate() }}>
                <CircleArrowUp className="menu-icon" aria-hidden />
                <span className="menu-label">{update.state === 'ready' ? `Restart to update to ${update.version}` : update.state === 'available' ? `Get nexttupp ${update.version}` : `Update to ${update.version}`}</span>
              </button>
              )
            : (
              <button type="button" role="menuitem" className="menu-item" onClick={checkForUpdate}>
                <RefreshCw className="menu-icon" aria-hidden />
                <span className="menu-label">Check for updates</span>
              </button>
              ))}
        </div>
      )}
    </div>
  )
}
