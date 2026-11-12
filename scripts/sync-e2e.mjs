// Sign-in and sync, end to end, on this machine only: a local Worker (`cd cloud && npm run dev`, or
// `wrangler dev --local`) and two nexttupp servers with their own data dirs, standing in for two laptops.
//
//   node scripts/sync-e2e.mjs
//   A=http://127.0.0.1:4550 B=http://127.0.0.1:4551 CLOUD=http://127.0.0.1:8799   (the defaults)
//
// Start each server with NEXTTUPP_DATA=<its own scratch dir> NEXTTUPP_CLOUD_URL=$CLOUD PORT=…, never the
// real data dir. Phase 1: one person on two laptops (A creates an account, B signs in to the same
// account; its own "Me" merges into the account's). Likes, My List and profile deletions go both ways,
// and removals reach the cloud as tombstones. Phase 2: a friend creates their own account on B; the
// friend's account sees none of the owner's data.
import { pbkdf2Sync } from 'node:crypto'

const A = process.env.A ?? 'http://127.0.0.1:4550'
const B = process.env.B ?? 'http://127.0.0.1:4551'
const CLOUD = process.env.CLOUD ?? 'http://127.0.0.1:8799'

const OWNER = { email: `owner-${Date.now().toString(36)}@example.test`, password: 'owner password 123' }
const FRIEND = { email: `friend-${Date.now().toString(36)}@example.test`, password: 'friend password 456' }
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

/** Reads the account straight from the cloud, as a client would: prelogin, PBKDF2, login, pull everything. */
async function cloudPull (who) {
  const post = (path, body, token) => fetch(CLOUD + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(r => r.json())
  const pre = await post('/v1/auth/prelogin', { email: who.email })
  const key = pbkdf2Sync(who.password.normalize('NFC'), Buffer.from(pre.salt, 'base64url'), pre.iterations, 32, 'sha256').toString('base64url')
  const { token } = await post('/v1/auth/login', { email: who.email, key })
  const out = { profiles: [], ratings: [], list: [], events: [] }
  for (let since = '0'; ;) {
    const page = await fetch(`${CLOUD}/v1/sync/pull?since=${since}`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json())
    for (const k of Object.keys(out)) out[k].push(...page[k])
    since = page.cursor
    if (!page.more) break
  }
  await fetch(`${CLOUD}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  return out
}

// ---- Phase 1: one person, two laptops -------------------------------------------------------

const [aMe] = await profiles(A)
const [bMe] = await profiles(B)
await api(B, 'PUT', `/api/me/rating/movie/${GODFATHER}`, { value: 1, source: 'title' }, bMe.id)

const joinedA = await api(A, 'POST', '/api/account/signup', { email: OWNER.email, password: OWNER.password, displayName: 'Owner' })
check('A creates an account, no invite needed', joinedA.signedIn && joinedA.account.role === 'member' && joinedA.sync.state === 'synced', joinedA.sync?.state)
check('the session token never reaches the browser', !JSON.stringify(joinedA).includes('nxs_'))
const kid = await api(A, 'POST', '/api/profiles', { name: 'Kid' })
await api(A, 'PUT', `/api/me/rating/movie/${MATRIX}`, { value: 1, source: 'title' }, aMe.id)
await api(A, 'PUT', `/api/me/list/movie/${SHAWSHANK}`, undefined, aMe.id)
await sync(A)

const signedB = await api(B, 'POST', '/api/account/login', OWNER)
check('B signs in to the same account', signedB.signedIn && signedB.account.email === OWNER.email && signedB.sync.state === 'synced', signedB.sync?.state)
check('B’s own "Me" merges into the account’s "Me"', signedB.merged?.[bMe.id] === aMe.id, JSON.stringify(signedB.merged))
const bNames = (await profiles(B)).map(p => p.name).sort()
check('B now has the account’s profiles, once each', JSON.stringify(bNames) === JSON.stringify(['Kid', 'Me']), bNames.join(', '))
check('A’s like reached B', (await state(B, aMe.id, MATRIX)).rating === 1)
check('A’s My List reached B', (await state(B, aMe.id, SHAWSHANK)).inList === true)
check('B’s like from before sign-in is kept', (await state(B, aMe.id, GODFATHER)).rating === 1)
await sync(A)
check('B’s earlier like reached A', (await state(A, aMe.id, GODFATHER)).rating === 1)

// Edit on B, see it on A: change a like to a dislike, take a title off My List, delete a profile.
await api(B, 'PUT', `/api/me/rating/movie/${MATRIX}`, { value: -1, source: 'title' }, aMe.id)
await api(B, 'DELETE', `/api/me/list/movie/${SHAWSHANK}`, undefined, aMe.id)
await api(B, 'PUT', `/api/me/rating/movie/${GODFATHER}`, { value: 0 }, aMe.id)
await api(B, 'DELETE', `/api/profiles/${kid.id}`)
await sync(B)
await sync(A)
check('B’s dislike reached A', (await state(A, aMe.id, MATRIX)).rating === -1)
check('B’s My List removal reached A', (await state(A, aMe.id, SHAWSHANK)).inList === false)
check('B’s cleared rating reached A', (await state(A, aMe.id, GODFATHER)).rating === 0)
check('the profile deleted on B is gone on A', !(await profiles(A)).some(p => p.id === kid.id))

const cloud = await cloudPull(OWNER)
check('removals are tombstone rows in the cloud (inList 0, value 0), not deletes',
  cloud.list.some(r => r.itemId === SHAWSHANK && r.inList === 0) && cloud.ratings.some(r => r.itemId === GODFATHER && r.value === 0))
check('the deleted profile is a tombstone in the cloud', cloud.profiles.some(p => p.id === kid.id && p.deletedAt !== null))
check('B’s retired local "Me" never reached the cloud', !cloud.profiles.some(p => p.id === bMe.id))
check('the cloud holds no titles, sources or file names', !/infoHash|magnet|fileName|\.mkv|\.mp4|Matrix|Shawshank/i.test(JSON.stringify(cloud)))

// ---- Phase 2: a friend's own account ----------------------------------------------------------

const out = await api(B, 'POST', '/api/account/logout', {})
check('B signs out', out.signedIn === false)
check('signed out, B keeps its local data', (await state(B, aMe.id, MATRIX)).rating === -1)
const friend = await api(B, 'POST', '/api/account/signup', { email: FRIEND.email, password: FRIEND.password, displayName: 'Friend' })
check('the friend creates an account on B', friend.signedIn && friend.account.email === FRIEND.email && friend.account.role === 'member')
const fp = await api(B, 'POST', '/api/profiles', { name: 'Friend' })
await api(B, 'PUT', `/api/me/rating/movie/${SHAWSHANK}`, { value: 1 }, fp.id)
await sync(B)
const friendCloud = await cloudPull(FRIEND)
check('the friend’s account holds only the friend’s profile', friendCloud.profiles.length === 1 && friendCloud.profiles[0].id === fp.id, friendCloud.profiles.map(p => p.name).join(', '))
await sync(A)
check('the owner never sees the friend’s profile', !(await profiles(A)).some(p => p.id === fp.id))
const taken = await fetch(`${B}/api/account/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: FRIEND.email, password: FRIEND.password }) })
check('an email can only have one account', taken.status === 409)
const csrf = await fetch(`${A}/api/account/logout`, { method: 'POST' })
check('account writes need a JSON body (no cross-site sign-out)', csrf.status === 415)

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
console.log(`OWNER=${OWNER.email} FRIEND=${FRIEND.email}`)
process.exit(failed ? 1 : 0)
