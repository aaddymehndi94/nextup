import { useSyncExternalStore } from 'react'

// Private mode, for this window (or this phone's tab) only. While it's on, every request says so and the
// server saves nothing (server/private.ts); here, nothing goes into the browser's storage either
// (storage.ts keeps it in memory) and images load uncached (api.ts). Closing the window ends it. The flag
// itself sits in sessionStorage so a reload doesn't quietly switch it off; it records nothing else.

const KEY = 'nexttupp:private'

function load (): boolean {
  try { return sessionStorage.getItem(KEY) === '1' } catch { return false }
}

let on = load()
const listeners = new Set<() => void>()

export const isPrivate = (): boolean => on

/** What storage.ts would have saved while private mode is on (playback positions and the like), in memory only. */
export const privateMemory = new Map<string, string>()

export function setPrivate (value: boolean): void {
  if (value === on) return
  on = value
  privateMemory.clear()
  try { if (value) sessionStorage.setItem(KEY, '1'); else sessionStorage.removeItem(KEY) } catch { /* this page only */ }
  listeners.forEach(fn => fn())
}

export function usePrivate (): boolean {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    () => on,
  )
}
