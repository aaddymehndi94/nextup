import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from '../src/crypto.ts'

// Measures one PBKDF2-SHA256 hash inside workerd, the runtime Workers use. Workers only advance the clock
// at I/O, so each timing is bracketed by a trivial D1 query and the same bracket without hashing is
// subtracted. Prints the result; asserts only that hashing works.
it(`measures PBKDF2-SHA256 x${PBKDF2_ITERATIONS} in workerd`, async () => {
  const tick = async () => { await env.DB.prepare('SELECT 1').first(); return Date.now() }
  const N = 20
  let t = await tick()
  for (let i = 0; i < N; i++) await tick()
  const overhead = ((await tick()) - t) / (N + 1)
  const hash = await hashPassword('warm-up password')
  const samples: number[] = []
  for (let i = 0; i < N; i++) {
    t = await tick()
    await verifyPassword('warm-up password', hash)
    samples.push((await tick()) - t - overhead)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(N / 2)]
  console.log(`[hash-cost] PBKDF2-SHA256 x${PBKDF2_ITERATIONS} in workerd: median ${median.toFixed(1)} ms, min ${samples[0].toFixed(1)} ms, max ${samples[N - 1].toFixed(1)} ms over ${N} runs (I/O overhead ${overhead.toFixed(2)} ms subtracted)`)
  expect(await verifyPassword('warm-up password', hash)).toBe(true)
  expect(await verifyPassword('wrong', hash)).toBe(false)
}, 60_000)
