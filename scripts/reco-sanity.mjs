#!/usr/bin/env node
// Recommendation sanity check against a running server (never the owner's: pass your own URL).
// Creates a throwaway profile per taste, likes a coherent set of titles, waits for background warming,
// then prints the home rows with their reasons, the taste summary and "more like this" for one title.
//
//   node scripts/reco-sanity.mjs http://127.0.0.1:4548 [taste ...] [--keep] [--items=10]
//
// Tastes: quiet (romance/indie drama), action (80s/90s action), scifi (cerebral sci-fi, films + series),
// cold (no signals), hijack (quiet + one accidental play of a horror film: the feed must not change).

const args = process.argv.slice(2)
const base = (args.find(a => a.startsWith('http')) ?? 'http://127.0.0.1:4548').replace(/\/$/, '')
const keep = args.includes('--keep')
const perRow = Number(args.find(a => a.startsWith('--items='))?.split('=')[1] ?? 10)

const TASTES = {
  quiet: {
    label: 'Quiet romance / indie drama',
    likes: [['Before Sunrise', 1995], ['Lost in Translation', 2003], ['Past Lives', 2023], ['In the Mood for Love', 2000], ['Aftersun', 2022], ['Normal People', 2020, 'series']],
    dislikes: [['Fast X', 2023]],
  },
  action: {
    label: '80s/90s action',
    likes: [['Die Hard', 1988], ['Terminator 2: Judgment Day', 1991], ['Lethal Weapon', 1987], ['Predator', 1987], ['Point Break', 1991], ['Speed', 1994], ['The Rock', 1996]],
    dislikes: [['The Notebook', 2004]],
  },
  scifi: {
    label: 'Cerebral sci-fi (films + series)',
    likes: [['Arrival', 2016], ['Ex Machina', 2014], ['Annihilation', 2018], ['Dark', 2017, 'series'], ['Severance', 2022, 'series']],
    dislikes: [],
  },
  cold: { label: 'Cold start (no signals)', likes: [], dislikes: [] },
  hijack: {
    label: 'Quiet + one accidental 60 s play of a horror film',
    likes: [['Before Sunrise', 1995], ['Lost in Translation', 2003], ['Past Lives', 2023]],
    dislikes: [],
    accidental: ['Terrifier 3', 2024],
  },
}

const chosen = args.filter(a => !a.startsWith('http') && !a.startsWith('--'))
const run = chosen.length ? chosen : ['quiet', 'action']

async function call (method, path, profile, body) {
  const headers = { accept: 'application/json' }
  if (profile) headers['x-nexttupp-profile'] = profile
  if (body !== undefined) headers['content-type'] = 'application/json'
  const began = performance.now()
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const ms = performance.now() - began
  if (res.status === 204) return { ms }
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? ''}`)
  return Object.assign(json, { _ms: ms })
}

async function find (name, year, type) {
  const results = await call('GET', `/api/search?q=${encodeURIComponent(name)}`)
  const want = name.toLowerCase()
  const ok = r => (!type || r.type === type) && (!year || String(r.year ?? '').startsWith(String(year)))
  return results.find(r => r.name.toLowerCase() === want && ok(r)) ?? results.find(ok) ?? results[0]
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitWarm (profile) {
  const began = Date.now()
  let home
  do {
    await sleep(1500)
    home = await call('GET', '/api/me/home', profile)
  } while (home.warming && Date.now() - began < 180_000)
  return home
}

function printHome (home) {
  for (const row of home.rows) {
    console.log(`\n  ▸ ${row.title}${row.subtitle ? `  (${row.subtitle})` : ''}`)
    for (const it of row.items.slice(0, perRow)) {
      const kind = it.type === 'series' ? ' [series]' : ''
      console.log(`      ${it.name} (${it.year ?? '?'})${kind}${it.imdbRating ? ` ${it.imdbRating}` : ''}  —  ${it.reason.text}`)
    }
  }
}

for (const key of run) {
  const taste = TASTES[key]
  if (!taste) { console.error(`unknown taste ${key}`); continue }
  console.log(`\n${'='.repeat(100)}\n${taste.label}\n${'='.repeat(100)}`)
  const profile = await call('POST', '/api/profiles', null, { name: `sanity ${key} ${Date.now() % 100000}` })
  try {
    for (const [list, value] of [[taste.likes, 1], [taste.dislikes, -1]]) {
      for (const [name, year, type] of list) {
        const t = await find(name, year, type)
        if (!t) { console.log(`  ! not found: ${name}`); continue }
        await call('PUT', `/api/me/rating/${t.type}/${t.id}`, profile.id, { value })
        console.log(`  ${value > 0 ? 'liked   ' : 'disliked'} ${t.name} (${t.year})`)
      }
    }
    let before = null
    if (taste.accidental) {
      before = await waitWarm(profile.id)
      const t = await find(...taste.accidental)
      // Two pings 60 s of film apart, as the player would send after a minute of watching.
      await call('POST', '/api/me/progress', profile.id, { type: t.type, id: t.id, streamId: t.id, position: 5, duration: 5400 })
      await call('POST', '/api/me/progress', profile.id, { type: t.type, id: t.id, streamId: t.id, position: 65, duration: 5400 })
      console.log(`  played   ${t.name} (${t.year}) for 60 s`)
    }
    const home = await waitWarm(profile.id)
    const timed = await call('GET', '/api/me/home', profile.id)
    // Bypass the per-profile cache to time a real build: clearing a (never set) preference bumps the profile version.
    await call('PUT', '/api/me/taste/feature', profile.id, { feature: 'g:Western', value: 0 })
    const fresh = await call('GET', '/api/me/home', profile.id)
    console.log(`\n  home: coldStart=${home.coldStart} rows=${home.rows.length} · cached ${timed._ms.toFixed(0)} ms · rebuilt ${fresh._ms.toFixed(0)} ms`)
    printHome(home)

    if (before) {
      const top = r => (r.rows.find(x => x.kind === 'top')?.items ?? []).slice(0, 12).map(i => i.id)
      const a = new Set(top(before))
      const b = top(home)
      const overlap = b.filter(id => a.has(id)).length
      const horror = r => r.rows.filter(x => x.kind !== 'continue').flatMap(x => x.items.slice(0, 8)).filter(i => i.genres.includes('Horror')).length
      console.log(`\n  hijack check: top-12 overlap before/after the accidental play ${overlap}/12 · horror titles in visible rows before ${horror(before)}, after ${horror(home)}`)
    }

    const tasteSummary = await call('GET', '/api/me/taste', profile.id)
    console.log(`\n  taste: ${tasteSummary.summary}  (confidence ${tasteSummary.confidence})`)
    console.log(`  likes: ${tasteSummary.likes.map(f => `${f.label} [${f.kind} ${f.weight}]`).join(', ')}`)
    if (tasteSummary.dislikes.length) console.log(`  dislikes: ${tasteSummary.dislikes.map(f => `${f.label} [${f.kind}]`).join(', ')}`)

    if (taste.likes.length) {
      const t = await find(...taste.likes[0])
      const sim = await call('GET', `/api/title/${t.type}/${t.id}/similar`, profile.id)
      console.log(`\n  ▸ More like ${t.name}  (${sim._ms.toFixed(0)} ms)`)
      for (const it of sim.items.slice(0, perRow)) console.log(`      ${it.name} (${it.year ?? '?'})  —  ${it.reason.text}`)
    } else {
      const ob = await call('GET', '/api/me/onboarding', profile.id)
      console.log(`\n  ▸ Onboarding (${ob.items.length}): ${ob.items.map(i => `${i.name} (${i.year})`).join(', ')}`)
    }
  } finally {
    if (!keep) await call('DELETE', `/api/profiles/${profile.id}`).catch(err => console.error(String(err)))
  }
}
