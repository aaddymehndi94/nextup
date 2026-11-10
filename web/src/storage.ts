// Browser storage under the `nexttupp:` prefix. Values saved before the rename live under `nextup:`;
// reads fall back to them so saved playback positions and subtitle choices survive, and the next write
// moves the value to the new key.

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
  if (!store) return null
  try { return store.getItem(PREFIX + name) ?? store.getItem(LEGACY_PREFIX + name) } catch { return null }
}

/** Writes (or with `null`, clears) the value, and drops any copy under the old prefix. */
export function writeKey (name: string, value: string | null, store: Store | null = local()) {
  if (!store) return
  try {
    if (value === null) store.removeItem(PREFIX + name)
    else store.setItem(PREFIX + name, value)
    store.removeItem(LEGACY_PREFIX + name)
  } catch { /* storage full or unavailable */ }
}

export const readSessionKey = (name: string) => readKey(name, session())
export const writeSessionKey = (name: string, value: string | null) => writeKey(name, value, session())
