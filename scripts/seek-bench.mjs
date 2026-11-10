// Seek latency loop: opens a session, then jumps to positions that are NOT downloaded yet and
// measures how long until playable output starts flowing. This is the "streaming gets stuck" metric.
//
//   node scripts/seek-bench.mjs <infoHash> [fileIdx] [mode: play|raw] [runs]
const BASE = process.env.BASE ?? 'http://127.0.0.1:4545'
const [infoHash, fileIdx = '0', mode = 'play', runs = '3'] = process.argv.slice(2)
const CAPS = 'h264,av1,vp9,aac,opus,mp3,flac'
const OUTPUT_BYTES = 300 * 1024

const j = (r) => r.json()
const s = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ infoHash, fileIdx: Number(fileIdx) }) }).then(j)
if (s.error) throw new Error(s.error)
const { probe } = await fetch(`${BASE}/api/sessions/${s.id}/probe?caps=${CAPS}`).then(j)
const dur = probe.durationSec

/** Picks a fraction of the file that isn't downloaded and is far from what is. */
function untouched (ranges) {
  for (let tries = 0; tries < 200; tries++) {
    const f = 0.05 + Math.random() * 0.85
    if (!ranges.some(([a, b]) => f > a - 0.03 && f < b + 0.03)) return f
  }
  return Math.random()
}

async function timeToBytes (url, n, headers = {}) {
  const ctrl = new AbortController()
  const start = performance.now()
  const res = await fetch(url, { signal: ctrl.signal, headers })
  let got = 0
  for await (const chunk of res.body) {
    got += chunk.length
    if (got >= n) break
  }
  ctrl.abort()
  return Math.round(performance.now() - start)
}

const times = []
for (let i = 0; i < Number(runs); i++) {
  const { ranges } = await fetch(`${BASE}/api/sessions/${s.id}`).then(j)
  const f = untouched(ranges)
  const ms = mode === 'raw'
    ? await timeToBytes(`${BASE}/stream/${s.id}/raw`, 2 << 20, { range: `bytes=${Math.floor(f * s.fileSize)}-` })
    : await timeToBytes(`${BASE}/stream/${s.id}/play.mp4?t=${(f * dur).toFixed(1)}&caps=${CAPS}`, OUTPUT_BYTES)
  times.push(ms)
  console.log(`seek to ${(f * 100).toFixed(1)}% → first output after ${(ms / 1000).toFixed(1)}s`)
}
times.sort((a, b) => a - b)
console.log(`${mode} median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s  (${s.fileName}, ${probe.video?.codec} ${probe.container})`)
