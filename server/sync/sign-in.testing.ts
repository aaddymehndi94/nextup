import type { SyncService } from './service.ts'

/** Tests: signs `sync` in the way the app does now, with Google (its fake cloud answers /v1/auth/ticket). */
export function signIn (sync: SyncService) {
  sync.googleLink(4545)
  return sync.finishGoogle(`nxt_${'a'.repeat(43)}`)
}
