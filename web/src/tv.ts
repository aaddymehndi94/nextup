// The nexttupp TV app (tv/) shows this web app full screen in an Android WebView and adds `window.NexttuppTV`.
// In a browser there's no bridge and these do nothing.

import { stopScrollRestore } from './router.ts'
import { installTvNavigation, type Sound } from './tvnav.ts'

interface Bridge {
  keepAwake (on: boolean): void
  showKeyboard (): void
  /** The TV's navigation sound: "up", "down", "left", "right" or "click" (silent when the TV's sound effects are off). */
  sound? (kind: Sound): void
  textField? (waiting: boolean): void
  version (): string
}

const bridge = (): Bridge | undefined => (window as { NexttuppTV?: Bridge }).NexttuppTV

/** Running inside the TV app. */
export const inTvApp = (): boolean => Boolean(bridge())

/** Keeps the TV's screensaver away while a film plays here. */
export function keepAwake (on: boolean): void {
  try { bridge()?.keepAwake(on) } catch { /* the bridge is gone (page unloading) */ }
}

/** At start, in the TV app: let the remote drive the page (`.tv` on <html> for the TV's styles). */
export function setUpTv (): void {
  if (!inTvApp()) return
  installTvNavigation({
    keyboard: () => { try { bridge()?.showKeyboard() } catch { /* no keyboard to show */ } },
    // An older app has no sounds.
    sound: kind => { try { bridge()?.sound?.(kind) } catch { /* no sound */ } },
    textField: waiting => { try { bridge()?.textField?.(waiting) } catch { /* an older app */ } },
    stopScrollRestore,
  })
}
