import { useSyncExternalStore } from 'react'
import type { DesktopBridge, DesktopUpdate } from '../../shared/desktop.ts'

/** The desktop app's bridge (desktop/src/preload.ts); undefined in a browser or on a phone. */
export const desktop: DesktopBridge | undefined = (window as unknown as { nexttuppDesktop?: DesktopBridge }).nexttuppDesktop

let update: DesktopUpdate | null = null
const listeners = new Set<() => void>()
desktop?.onUpdate(u => { update = u; listeners.forEach(fn => fn()) })

/** A newer nexttupp, from the desktop app (null when this is the latest, or in a browser). */
export const useDesktopUpdate = (): DesktopUpdate | null =>
  useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => update)
