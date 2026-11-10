import { useSyncExternalStore } from 'react'
import type { Profile } from '../../shared/types.ts'
import { api, getActiveProfile, onProfileGone, setActiveProfile } from './api.ts'
import { readSessionKey, writeSessionKey } from './storage.ts'

// "Who's watching": the profile list and the active profile, shared by every screen.
// With one profile it is chosen silently. With more, the picker opens once per browser session (as on a
// shared TV), with the last profile used on this device focused first.

export type ProfilesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; profiles: Profile[]; active: Profile | null; picking: boolean; gone?: boolean }

const PICKED = 'profile-picked'

let state: ProfilesState = { status: 'loading' }
const listeners = new Set<() => void>()
const set = (next: ProfilesState) => { state = next; listeners.forEach(l => l()) }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export const useProfiles = (): ProfilesState => useSyncExternalStore(subscribe, () => state)

function settle (profiles: Profile[], opts: { forcePick?: boolean; gone?: boolean } = {}) {
  const stored = getActiveProfile()
  let active = profiles.find(p => p.id === stored) ?? null
  let picking = false
  if (profiles.length === 1) {
    active = profiles[0]
  } else if (opts.forcePick || !active || readSessionKey(PICKED) !== '1') {
    picking = true
  }
  if (active?.id !== stored) setActiveProfile(active?.id ?? null)
  set({ status: 'ready', profiles, active, picking, gone: opts.gone })
}

export async function loadProfiles (opts: { forcePick?: boolean; gone?: boolean } = {}): Promise<void> {
  try {
    settle(await api.profiles(), opts)
  } catch (err) {
    set({ status: 'error', message: (err as Error).message })
  }
}

/** Makes `id` the active profile for this device and session. */
export function chooseProfile (id: string): void {
  if (state.status !== 'ready') return
  const active = state.profiles.find(p => p.id === id)
  if (!active) return
  setActiveProfile(id)
  writeSessionKey(PICKED, '1')
  set({ ...state, active, picking: false, gone: false })
}

export function openPicker (): void {
  if (state.status === 'ready') set({ ...state, picking: true })
}

export async function createProfile (name: string): Promise<Profile> {
  const p = await api.createProfile({ name })
  if (state.status === 'ready') set({ ...state, profiles: [...state.profiles, p] })
  return p
}

export async function renameProfile (id: string, name: string): Promise<Profile> {
  const p = await api.updateProfile(id, { name })
  if (state.status === 'ready') {
    set({ ...state, profiles: state.profiles.map(x => (x.id === id ? p : x)), active: state.active?.id === id ? p : state.active })
  }
  return p
}

/** The server refuses to delete the only profile (409); the caller shows that message. */
export async function deleteProfile (id: string): Promise<void> {
  await api.deleteProfile(id)
  if (state.status !== 'ready') return
  const profiles = state.profiles.filter(p => p.id !== id)
  if (state.active?.id === id) {
    setActiveProfile(null)
    settle(profiles, { forcePick: profiles.length > 1 })
  } else {
    set({ ...state, profiles })
  }
}

// Deleted elsewhere: drop it and send the viewer back to the picker.
onProfileGone(() => {
  setActiveProfile(null)
  void loadProfiles({ forcePick: true, gone: true })
})

/** One or two letters for an avatar: "Alex" → "A", "Mum & Dad" → "M". */
export const initial = (name: string) => (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()

/** Neutral tones only: colour belongs to the artwork. Stable per profile. */
export function avatarTone (p: Pick<Profile, 'id' | 'avatar'>): number {
  const fromKey = p.avatar && /^tone-[0-4]$/.test(p.avatar) ? Number(p.avatar.slice(5)) : null
  if (fromKey !== null) return fromKey
  let h = 0
  for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 5
}
