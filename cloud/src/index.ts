import { adminDisable, adminEnable, adminListAccounts, adminResetLink } from './admin.ts'
import { changePassword, getAccount, login, logout, patchAccount, prelogin, resetPassword, signup } from './auth.ts'
import { sendCode, verifyCode } from './codes.ts'
import { createHandoff, deleteDevice, listDevices, putDevice, redeemHandoff } from './devices.ts'
import { type Env, HttpError, errorResponse, json, Router } from './http.ts'
import { appScript, resetPage } from './pages.ts'
import { musicPull, musicPush } from './music.ts'
import { pull, push } from './sync.ts'

// nexttupp cloud: accounts and taste sync for the desktop app. No titles, sources, torrent
// hashes or file names ever reach it; see README.md.

export type { Env }

const router = new Router()
  .on('GET', '/v1/health', async ctx => json({ ok: true, serverTime: ctx.now }))

  .on('POST', '/v1/auth/code', sendCode)
  .on('POST', '/v1/auth/code/verify', verifyCode)
  // Passwords: for apps before 0.5.5 and accounts made before codes. New clients sign in with a code.
  .on('POST', '/v1/auth/signup', signup)
  .on('POST', '/v1/auth/prelogin', prelogin)
  .on('POST', '/v1/auth/login', login)
  .on('POST', '/v1/auth/logout', logout)
  .on('POST', '/v1/auth/reset', resetPassword)

  .on('GET', '/v1/account', getAccount)
  .on('PATCH', '/v1/account', patchAccount)
  .on('POST', '/v1/account/password', changePassword)

  .on('GET', '/v1/admin/accounts', adminListAccounts)
  .on('POST', '/v1/admin/accounts/:id/disable', adminDisable)
  .on('POST', '/v1/admin/accounts/:id/enable', adminEnable)
  .on('POST', '/v1/admin/accounts/:id/reset-link', adminResetLink)

  .on('GET', '/v1/devices', listDevices)
  .on('PUT', '/v1/devices/:id', putDevice)
  .on('DELETE', '/v1/devices/:id', deleteDevice)
  .on('POST', '/v1/devices/:id/handoff', createHandoff)
  .on('POST', '/v1/handoff/redeem', redeemHandoff)

  .on('POST', '/v1/sync/push', push)
  .on('GET', '/v1/sync/pull', pull)
  .on('POST', '/v1/sync/music/push', musicPush)
  .on('GET', '/v1/sync/music/pull', musicPull)

  .on('GET', '/reset', async () => resetPage())
  .on('GET', '/app.js', async () => appScript())

/** "0.5.10" → [0, 5, 10]; null if it isn't a plain dotted version, so odd values are let through. */
function parts (v: string): number[] | null {
  return /^\d+(\.\d+){0,3}$/.test(v) ? v.split('.').map(Number) : null
}

function older (a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d < 0
  }
  return false
}

/**
 * The owner's levers over apps already installed, both Worker variables set in the dashboard: MIN_APP_VERSION
 * turns away apps older than it (they show "Update needed" and stop calling), APP_NOTICE is one line every app
 * shows. Both ride on calls apps make anyway, so they cost no requests. Only apps say their version
 * (x-nexttupp-app, from 0.5.5); the website and older apps are never turned away.
 */
async function handle (req: Request, env: Env): Promise<Response> {
  const app = req.headers.get('x-nexttupp-app')?.trim()
  const have = app ? parts(app) : null
  const min = env.MIN_APP_VERSION ? parts(env.MIN_APP_VERSION.trim()) : null
  if (have && min && older(have, min)) {
    return errorResponse(new HttpError(426, 'update_required', `This version of nexttupp is too old to sync. Update to ${env.MIN_APP_VERSION!.trim()} or later.`))
  }
  const res = await router.handle(req, env)
  const notice = env.APP_NOTICE?.trim()
  if (!app || !notice) return res
  const out = new Response(res.body, res)
  out.headers.set('x-nexttupp-notice', encodeURIComponent(notice.slice(0, 200)))
  return out
}

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>
