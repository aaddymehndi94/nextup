import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { checkKey, makeVerifier } from '../src/crypto.ts'

// Measures what a login costs the Worker now that clients stretch passwords themselves: one
// HMAC-SHA256 check of the derived key, inside workerd. Workers only advance the clock at I/O, so a run of
// N checks is bracketed by a trivial D1 query and the same bracket without work is subtracted. The free
// plan allows 10 ms of CPU per request; this asserts a check stays far below 1 ms.
it('checks a client-derived key in well under a millisecond in workerd', async () => {
  const tick = async () => { await env.DB.prepare('SELECT 1').first(); return Date.now() }
  const key = crypto.getRandomValues(new Uint8Array(32))
  const stored = await makeVerifier(key, crypto.getRandomValues(new Uint8Array(16)), 600_000)
  const wrong = crypto.getRandomValues(new Uint8Array(32))
  const N = 200
  let t = await tick()
  const overhead = (await tick()) - t
  t = await tick()
  for (let i = 0; i < N; i++) await checkKey(key, stored)
  const perCheck = Math.max(0, (await tick()) - t - overhead) / N
  console.log(`[hash-cost] HMAC-SHA256 key check in workerd: ${perCheck.toFixed(3)} ms each over ${N} runs`)
  expect(perCheck).toBeLessThan(1)
  expect(await checkKey(key, stored)).toBe(true)
  expect(await checkKey(wrong, stored)).toBe(false)
  expect(await checkKey(key, 'pbkdf2-sha256$100000$abc$def')).toBe(false)
}, 60_000)
