import { changePassword, getAccount, login, logout, patchAccount, resetPassword } from './auth.ts'
import { type Env, json, Router } from './http.ts'
import {
  acceptInvite, adminDisable, adminEnable, adminListAccounts, adminListInvites, adminResetLink, adminRevokeInvite, createInvite, listMyInvites, revokeMyInvite,
} from './invites.ts'
import { appScript, joinPage, resetPage } from './pages.ts'
import { pull, push } from './sync.ts'

// nexttupp cloud: accounts, invites and taste sync for the desktop app. No titles, sources, torrent
// hashes or file names ever reach it; see README.md.

export type { Env }

const router = new Router()
  .on('GET', '/v1/health', async ctx => json({ ok: true, serverTime: ctx.now }))

  .on('POST', '/v1/auth/login', login)
  .on('POST', '/v1/auth/logout', logout)
  .on('POST', '/v1/auth/reset', resetPassword)

  .on('GET', '/v1/account', getAccount)
  .on('PATCH', '/v1/account', patchAccount)
  .on('POST', '/v1/account/password', changePassword)

  .on('POST', '/v1/invites', createInvite)
  .on('GET', '/v1/invites', listMyInvites)
  .on('POST', '/v1/invites/accept', acceptInvite)
  .on('DELETE', '/v1/invites/:id', revokeMyInvite)

  .on('GET', '/v1/admin/accounts', adminListAccounts)
  .on('POST', '/v1/admin/accounts/:id/disable', adminDisable)
  .on('POST', '/v1/admin/accounts/:id/enable', adminEnable)
  .on('POST', '/v1/admin/accounts/:id/reset-link', adminResetLink)
  .on('GET', '/v1/admin/invites', adminListInvites)
  .on('DELETE', '/v1/admin/invites/:id', adminRevokeInvite)

  .on('POST', '/v1/sync/push', push)
  .on('GET', '/v1/sync/pull', pull)

  .on('GET', '/join', async () => joinPage())
  .on('GET', '/reset', async () => resetPage())
  .on('GET', '/app.js', async () => appScript())

export default {
  fetch: (req: Request, env: Env) => router.handle(req, env),
} satisfies ExportedHandler<Env>
