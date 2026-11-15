// Sign-in and sync, end to end, on this machine only: a local Worker (`cd cloud && npm run dev`, or
// `wrangler dev --local`) and two nexttupp servers with their own data dirs, standing in for two laptops.
//
//   node scripts/sync-e2e.mjs
//   A=http://127.0.0.1:4550 B=http://127.0.0.1:4551 CLOUD=http://127.0.0.1:8799   (the defaults)
//   CLOUD_LOG=<the local Worker's output, e.g. `wrangler dev --local > cloud.log`>: sign-in codes are read from
//   it, since a local Worker only logs the emails it would send.
//
// Start each server with NEXTTUPP_DATA=<its own scratch dir> NEXTTUPP_CLOUD_URL=$CLOUD PORT=…, never the
// real data dir, and pass those dirs as A_DATA and B_DATA (defaults /tmp/nx-a, /tmp/nx-b): the script puts a
// few songs straight into each one's database, so Music needs no catalog or YouTube. Phase 1: one person on
// two laptops (A creates an account, B signs in to the same account; its own "Me" merges into the
// account's). Likes, My List, music likes, listens and AI mixes, and profile deletions go both ways, and
// removals reach the cloud as tombstones. Private mode sends nothing. Phase 2: a friend creates their own
// account on B; the friend's account sees none of the owner's data.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const A = process.env.A ?? 'http://127.0.0.1:4550'
const B = process.env.B ?? 'http://127.0.0.1:4551'
const CLOUD = process.env.CLOUD ?? 'http://127.0.0.1:8799'
const A_DATA = process.env.A_DATA ?? '/tmp/nx-a'
const B_DATA = process.env.B_DATA ?? '/tmp/nx-b'

const OWNER = { email: `owner-${Date.now().toString(36)}@example.test` }
const FRIEND = { email: `friend-${Date.now().toString(36)}@example.test` }
const CLOUD_LOG = process.env.CLOUD_LOG
if (!CLOUD_LOG) throw new Error('Set CLOUD_LOG to the local Worker’s output file (sign-in codes are read from it)')

/** Asks `send` for a code, then finds it in the local Worker's log: the newest one after the ask. */
async function emailedCode (send) {
  const from = readFileSync(CLOUD_LOG, 'utf8').length
  await send()
  for (let i = 0; i < 50; i++) {
    const m = [...readFileSync(CLOUD_LOG, 'utf8').slice(from).matchAll(/(\d{6}) is your nexttupp code/g)].at(-1)
    if (m) return m[1]
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('no sign-in code in CLOUD_LOG')
}

/** Signs a nexttupp server in (or up) the way the app does: email, then the code. */
async function signIn (server, who, displayName) {
  const code = await emailedCode(() => fetch(`${server}/api/account/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: who.email }) }))
  return api(server, 'POST', '/api/account/verify', { email: who.email, code, ...(displayName ? { displayName } : {}) })
}
const GODFATHER = 'tt0068646'
const MATRIX = 'tt0133093'
const SHAWSHANK = 'tt0111161'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function api (base, method, path, body, profile) {
  const headers = { 'content-type': 'application/json' }
  if (profile) headers['x-nexttupp-profile'] = profile
  const res = await fetch(base + path, { method, headers: body === undefined && method === 'GET' ? (profile ? { 'x-nexttupp-profile': profile } : {}) : headers, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${base}${path}: ${res.status} ${text}`)
  return json
}
const sync = base => api(base, 'POST', '/api/account/sync', {})
const state = (base, profile, id) => api(base, 'GET', `/api/me/state/movie/${id}`, undefined, profile)
const profiles = base => api(base, 'GET', '/api/profiles')

// ---- Music helpers ----------------------------------------------------------------------------

const hex = (s, n) => createHash('sha1').update(s).digest('hex').slice(0, n)
const SONG = (artist, title) => ({ id: `t${hex(`e2e|${artist}|${title}`, 16)}`, title, artist, artistId: `a${hex(`e2e|${artist}`, 12)}` })
const KESARIYA = SONG('Arijit Singh', 'Kesariya')
const TUM_HI_HO = SONG('Arijit Singh', 'Tum Hi Ho')
const BROWN = SONG('AP Dhillon', 'Brown Munde')
const AI_MIX = `m${hex('e2e mix', 15)}`
const COVER = 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/aa/bb/cc/source/600x600bb.jpg'

/** The server's own database (WAL, so it can stay open while the server runs). */
function local (dir, fn) {
  const db = new DatabaseSync(join(dir, 'nexttupp.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  try { return fn(db) } finally { db.close() }
}
/** Songs this computer has "seen", as browsing Music would leave them. */
const seed = (dir, ...songs) => local(dir, db => {
  for (const t of songs) {
    db.prepare(`INSERT OR IGNORE INTO music_tracks (id, title, artist_id, artist, album_id, album, cover, duration, seen_at)
                VALUES (?, ?, ?, ?, 'it1630340270', ?, ?, 240, ?)`).run(t.id, t.title, t.artistId, t.artist, `${t.title} (Single)`, COVER, Date.now())
    db.prepare("INSERT OR IGNORE INTO music_artists (id, name, deezer_id, seen_at) VALUES (?, ?, '4495513', ?)").run(t.artistId, t.artist, Date.now())
  }
})
const rate = (base, profile, kind, id, rating, headers = {}) => fetch(`${base}/api/music/rate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexttupp-profile': profile, ...headers }, body: JSON.stringify({ kind, id, rating }) })
const listen = (base, profile, trackId, headers = {}) => fetch(`${base}/api/music/listen`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexttupp-profile': profile, ...headers }, body: JSON.stringify({ trackId, played: 200, how: 'ended' }) })
const songState = (base, profile, id) => api(base, 'GET', `/api/music/track/${id}`, undefined, profile)
const count = (dir, sql, ...p) => local(dir, db => Number(db.prepare(sql).get(...p).n))

/** Reads the account straight from the cloud, as a client would: a code by email, then pull everything. */
async function cloudPull (who) {
  const post = (path, body, token) => fetch(CLOUD + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(r => r.json())
  const code = await emailedCode(() => post('/v1/auth/code', { email: who.email }))
  const { token } = await post('/v1/auth/code/verify', { email: who.email, code })
  const all = async (path, out) => {
    for (let since = '0'; ;) {
      const page = await fetch(`${CLOUD}${path}?since=${since}`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json())
      for (const k of Object.keys(out)) out[k].push(...page[k])
      since = page.cursor
      if (!page.more) return out
    }
  }
  const out = await all('/v1/sync/pull', { profiles: [], ratings: [], list: [], events: [] })
  out.music = await all('/v1/sync/music/pull', { artists: [], tracks: [], ratings: [], listens: [], mixes: [] })
  await fetch(`${CLOUD}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  return out
}

// ---- Phase 1: one person, two laptops -------------------------------------------------------

const [aMe] = await profiles(A)
const [bMe] = await profiles(B)
await api(B, 'PUT', `/api/me/rating/movie/${GODFATHER}`, { value: 1, source: 'title' }, bMe.id)
// B's music before signing in: a song and an artist liked, a song played, an AI mix.
seed(B_DATA, KESARIYA, BROWN)
await rate(B, bMe.id, 'track', KESARIYA.id, 1)
await rate(B, bMe.id, 'artist', BROWN.artistId, 1)
await listen(B, bMe.id, BROWN.id)
local(B_DATA, db => db.prepare("INSERT INTO music_mixes (id, profile_id, kind, title, subtitle, tracks, model, at) VALUES (?, ?, 'ai', 'Late drive', 'Punjabi for the road', ?, 'gpt-5.1', ?)")
  .run(AI_MIX, bMe.id, JSON.stringify([{ id: BROWN.id, why: 'You love his flow' }, { id: KESARIYA.id }]), Date.now()))

const joinedA = await signIn(A, OWNER, 'Owner')
check('A creates an account with a code by email, no invite or password', joinedA.signedIn && joinedA.account.role === 'member' && joinedA.sync.state === 'synced', joinedA.sync?.state)
check('the session token never reaches the browser', !JSON.stringify(joinedA).includes('nxs_'))
const kid = await api(A, 'POST', '/api/profiles', { name: 'Kid' })
await api(A, 'PUT', `/api/me/rating/movie/${MATRIX}`, { value: 1, source: 'title' }, aMe.id)
await api(A, 'PUT', `/api/me/list/movie/${SHAWSHANK}`, undefined, aMe.id)
seed(A_DATA, TUM_HI_HO)
await rate(A, aMe.id, 'track', TUM_HI_HO.id, 1)
await listen(A, aMe.id, TUM_HI_HO.id)
await sync(A)

const signedB = await signIn(B, OWNER)
check('B signs in to the same account', signedB.signedIn && signedB.account.email === OWNER.email && signedB.sync.state === 'synced', signedB.sync?.state)
check('B’s own "Me" merges into the account’s "Me"', signedB.merged?.[bMe.id] === aMe.id, JSON.stringify(signedB.merged))
const bNames = (await profiles(B)).map(p => p.name).sort()
check('B now has the account’s profiles, once each', JSON.stringify(bNames) === JSON.stringify(['Kid', 'Me']), bNames.join(', '))
check('A’s like reached B', (await state(B, aMe.id, MATRIX)).rating === 1)
check('A’s My List reached B', (await state(B, aMe.id, SHAWSHANK)).inList === true)
check('B’s like from before sign-in is kept', (await state(B, aMe.id, GODFATHER)).rating === 1)
await sync(A)
check('B’s earlier like reached A', (await state(A, aMe.id, GODFATHER)).rating === 1)
check('A’s music like reached B, song details included', (await songState(B, aMe.id, TUM_HI_HO.id).catch(() => ({}))).rating === 1)
const kOnA = await songState(A, aMe.id, KESARIYA.id).catch(() => ({}))
check('B’s music like from before sign-in reached A, with the song', kOnA.rating === 1 && kOnA.track?.title === 'Kesariya', JSON.stringify(kOnA).slice(0, 120))
check('B’s artist like reached A', count(A_DATA, "SELECT COUNT(*) AS n FROM music_ratings WHERE profile_id = ? AND kind = 'artist' AND item_id = ? AND rating = 1", aMe.id, BROWN.artistId) === 1)
check('listens from both laptops are on both', count(A_DATA, 'SELECT COUNT(*) AS n FROM music_listens WHERE profile_id = ?', aMe.id) === 2 && count(B_DATA, 'SELECT COUNT(*) AS n FROM music_listens WHERE profile_id = ?', aMe.id) === 2)
const mixOnA = await api(A, 'GET', `/api/music/mix/${AI_MIX}`, undefined, aMe.id).catch(() => ({}))
check('B’s AI mix reached A, with its songs', mixOnA.title === 'Late drive' && mixOnA.tracks?.map(t => t.title).join() === 'Brown Munde,Kesariya', JSON.stringify(mixOnA).slice(0, 120))
const likedOnA = await api(A, 'GET', '/api/music/mix/liked', undefined, aMe.id)
check('A’s Liked songs shows both laptops’ likes', likedOnA.tracks.map(t => t.title).sort().join() === 'Kesariya,Tum Hi Ho', likedOnA.tracks.map(t => t.title).join(', '))

// Edit on B, see it on A: change a like to a dislike, take a title off My List, delete a profile.
await api(B, 'PUT', `/api/me/rating/movie/${MATRIX}`, { value: -1, source: 'title' }, aMe.id)
await api(B, 'DELETE', `/api/me/list/movie/${SHAWSHANK}`, undefined, aMe.id)
await api(B, 'PUT', `/api/me/rating/movie/${GODFATHER}`, { value: 0 }, aMe.id)
await api(B, 'DELETE', `/api/profiles/${kid.id}`)
await rate(B, aMe.id, 'track', KESARIYA.id, 0)
await sync(B)
await sync(A)
check('B’s music unlike reached A', (await songState(A, aMe.id, KESARIYA.id)).rating === 0)

// Private mode on B: no music like is taken, no listen is kept, and nothing new goes to the cloud.
const listensBefore = count(B_DATA, 'SELECT COUNT(*) AS n FROM music_listens')
const privRate = await rate(B, aMe.id, 'track', BROWN.id, 1, { 'x-nexttupp-private': '1' })
await listen(B, aMe.id, BROWN.id, { 'x-nexttupp-private': '1' })
check('private mode refuses music likes and keeps no listens', privRate.status === 409 && count(B_DATA, 'SELECT COUNT(*) AS n FROM music_listens') === listensBefore &&
  count(B_DATA, 'SELECT COUNT(*) AS n FROM sync_music_outbox') === 0)
check('B’s dislike reached A', (await state(A, aMe.id, MATRIX)).rating === -1)
check('B’s My List removal reached A', (await state(A, aMe.id, SHAWSHANK)).inList === false)
check('B’s cleared rating reached A', (await state(A, aMe.id, GODFATHER)).rating === 0)
check('the profile deleted on B is gone on A', !(await profiles(A)).some(p => p.id === kid.id))

const cloud = await cloudPull(OWNER)
check('removals are tombstone rows in the cloud (inList 0, value 0), not deletes',
  cloud.list.some(r => r.itemId === SHAWSHANK && r.inList === 0) && cloud.ratings.some(r => r.itemId === GODFATHER && r.value === 0))
check('the deleted profile is a tombstone in the cloud', cloud.profiles.some(p => p.id === kid.id && p.deletedAt !== null))
check('B’s retired local "Me" never reached the cloud', !cloud.profiles.some(p => p.id === bMe.id))
check('the cloud holds no titles, sources or file names', !/infoHash|magnet|fileName|\.mkv|\.mp4|Matrix|Shawshank/i.test(JSON.stringify({ ...cloud, music: undefined })))
const m = cloud.music
check('the cloud has the music: likes (an unlike kept as 0), listens, the AI mix, and the songs they name',
  m.ratings.some(r => r.itemId === KESARIYA.id && r.value === 0) && m.ratings.some(r => r.itemId === TUM_HI_HO.id && r.value === 1) &&
  m.listens.length === 2 && m.mixes.map(x => x.id).join() === AI_MIX && [KESARIYA, TUM_HI_HO, BROWN].every(t => m.tracks.some(x => x.id === t.id)),
  `${m.ratings.length} likes, ${m.listens.length} listens, ${m.mixes.length} mixes, ${m.tracks.length} songs`)
check('music in the cloud is under the account’s "Me" only, with no files or video ids', !JSON.stringify(m).includes(bMe.id) && !/youtube|dQw4|\.m4a|music_files/i.test(JSON.stringify(m)))

// ---- Phase 2: a friend's own account ----------------------------------------------------------

const out = await api(B, 'POST', '/api/account/logout', {})
check('B signs out', out.signedIn === false)
check('signed out, B keeps its local data', (await state(B, aMe.id, MATRIX)).rating === -1)
const friend = await signIn(B, FRIEND, 'Friend')
check('the friend creates an account on B', friend.signedIn && friend.account.email === FRIEND.email && friend.account.role === 'member')
const fp = await api(B, 'POST', '/api/profiles', { name: 'Friend' })
await api(B, 'PUT', `/api/me/rating/movie/${SHAWSHANK}`, { value: 1 }, fp.id)
await sync(B)
const friendCloud = await cloudPull(FRIEND)
check('the friend’s account holds only the friend’s profile', friendCloud.profiles.length === 1 && friendCloud.profiles[0].id === fp.id, friendCloud.profiles.map(p => p.name).join(', '))
check('the friend’s account holds none of the owner’s music', Object.values(friendCloud.music).every(rows => rows.length === 0))
await sync(A)
check('the owner never sees the friend’s profile', !(await profiles(A)).some(p => p.id === fp.id))
const cloudPost = (path, body) => fetch(CLOUD + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
const again = await cloudPost('/v1/auth/code/verify', { email: FRIEND.email, code: await emailedCode(() => cloudPost('/v1/auth/code', { email: FRIEND.email })) })
check('an email has one account: a second code signs in to it, not a new one', again.created === false && again.account?.email === FRIEND.email)
const csrf = await fetch(`${A}/api/account/logout`, { method: 'POST' })
check('account writes need a JSON body (no cross-site sign-out)', csrf.status === 415)

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
console.log(`OWNER=${OWNER.email} FRIEND=${FRIEND.email}`)
process.exit(failed ? 1 : 0)
