// Browser storage under the `nexttupp:` prefix. Values saved before the rename live under `nextup:`;
// reads fall back to them so saved playback positions and subtitle choices survive, and the next write
// moves the value to the new key. In private mode nothing is written: values live in memory until the
// window closes or private mode ends (private.ts), and reads see them first.

import { isPrivate, privateMemory } from './private.ts'

const PREFIX = 'nexttupp:'
const LEGACY_PREFIX = 'nextup:'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function local (): Store | null {
  try { return window.localStorage } catch { return null }
}
function session (): Store | null {
  try { return window.sessionStorage } catch { return null }
}

export function readKey (name: string, store: Store | null = local()): string | null {
  if (isPrivate() && privateMemory.has(PREFIX + name)) return privateMemory.get(PREFIX + name) ?? null
  if (!store) return null
  try { return store.getItem(PREFIX + name) ?? store.getItem(LEGACY_PREFIX + name) } catch { return null }
}

/** Writes (or with `null`, clears) the value, and drops any copy under the old prefix. */
export function writeKey (name: string, value: string | null, store: Store | null = local()) {
  if (isPrivate()) {
    if (value === null) privateMemory.delete(PREFIX + name); else privateMemory.set(PREFIX + name, value)
    return
  }
  if (!store) return
  try {
    if (value === null) store.removeItem(PREFIX + name)
    else store.setItem(PREFIX + name, value)
    store.removeItem(LEGACY_PREFIX + name)
  } catch { /* storage full or unavailable */ }
}

export const readSessionKey = (name: string) => readKey(name, session())

/**
 * Click handler (capture phase) for an area of title links: remembers, for this window, where the clicked title
 * was opened from: the nearest `data-source` (a home row id), else `fallback`. The player sends it with
 * progress, so the play can be traced to the row that led to it.
 */
export function noteSource (e: { target: EventTarget }, fallback?: string): void {
  const link = e.target instanceof Element ? e.target.closest('a[href^="/title/"]') : null
  const id = link?.getAttribute('href')?.split(/[/?]/)[3]
  const from = link?.closest('[data-source]')?.getAttribute('data-source') ?? fallback
  if (id && from) writeSessionKey(`from:${id}`, from)
}
export const writeSessionKey = (name: string, value: string | null) => writeKey(name, value, session())
