import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../src/index.ts'
import { BASE } from './helpers.ts'

// The owner's two levers over apps already out there, set as Worker variables in the dashboard (no deploy):
// MIN_APP_VERSION turns older apps away with "update", APP_NOTICE puts one line in front of every app.
// They ride on calls the apps make anyway; apps say their version in x-nexttupp-app (0.5.5 and later).

async function call (vars: Record<string, string>, app?: string) {
  const headers: Record<string, string> = {}
  if (app) headers['x-nexttupp-app'] = app
  const res = await worker.fetch(new Request(`${BASE}/v1/health`, { headers }), { ...env, ...vars })
  return { status: res.status, notice: res.headers.get('x-nexttupp-notice'), body: await res.json() as Record<string, unknown> }
}

describe('app versions and notices', () => {
  it('turns away apps older than the minimum, with a message the app shows', async () => {
    const old = await call({ MIN_APP_VERSION: '0.5.10' }, '0.5.9')
    expect(old.status).toBe(426)
    expect(old.body.error).toBe('update_required')
    expect(old.body.message).toMatch(/update/i)
    expect((await call({ MIN_APP_VERSION: '0.5.10' }, '0.5.10')).status).toBe(200)
    expect((await call({ MIN_APP_VERSION: '0.5.10' }, '0.6.0')).status).toBe(200)
  })

  it('leaves alone what doesn’t say its version: apps before 0.5.5 and the website', async () => {
    expect((await call({ MIN_APP_VERSION: '9.0.0' })).status).toBe(200)
  })

  it('no minimum set: every version is fine', async () => {
    expect((await call({}, '0.0.1')).status).toBe(200)
  })

  it('hands apps the notice, encoded so any text survives a header', async () => {
    const r = await call({ APP_NOTICE: 'Watch party is here — update to try it' }, '0.5.5')
    expect(decodeURIComponent(r.notice!)).toBe('Watch party is here — update to try it')
    expect((await call({ APP_NOTICE: 'x' })).notice).toBeNull()
    expect((await call({}, '0.5.5')).notice).toBeNull()
  })
})
