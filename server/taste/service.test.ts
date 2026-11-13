import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HomeResponse } from '../../shared/types.ts'
import { openDb } from '../db.ts'
import { type CfModel, parseCf } from '../reco/cf.ts'
import { SqliteTasteStore } from '../store.ts'
import { ItemCache } from './items.ts'
import { RecoService } from './service.ts'
import { registerTasteRoutes } from './routes.ts'

// The adapter end to end: SQLite store + item cache (fed by a fake Cinemeta) + the real CfModel parsed
// from the CF agent's fixture, or no model at all.

const SHAWSHANK = 'tt0111161'
const GODFATHER = 'tt0068646'
const GODFATHER2 = 'tt0071562'
const DIE_HARD = 'tt0095016'
const BEFORE_SUNRISE = 'tt0112471'

const meta = (id: string, name: string, year: number, genres: string[], director: string, rating = '8.0') => ({
  id, imdb_id: id, type: 'movie', name, releaseInfo: String(year), released: `${year}-03-01T00:00:00.000Z`,
  poster: `https://images.metahub.space/poster/small/${id}/img`, genre: genres, director: [director], writer: [director],
  cast: [`${name} Lead`], country: 'United States', imdbRating: rating, popularities: { moviedb: 20 }, runtime: '120 min',
  description: `${name}: a story.`,
})

const METAS = [
  meta(SHAWSHANK, 'The Shawshank Redemption', 1994, ['Drama'], 'Frank Darabont', '9.3'),
  meta(GODFATHER, 'The Godfather', 1972, ['Crime', 'Drama'], 'Francis Ford Coppola', '9.2'),
  meta(GODFATHER2, 'The Godfather Part II', 1974, ['Crime', 'Drama'], 'Francis Ford Coppola', '9.0'),
  meta(DIE_HARD, 'Die Hard', 1988, ['Action', 'Thriller'], 'John McTiernan', '8.2'),
  meta(BEFORE_SUNRISE, 'Before Sunrise', 1995, ['Drama', 'Romance'], 'Richard Linklater', '8.1'),
  ...Array.from({ length: 30 }, (_, i) => meta(`tt80000${String(i).padStart(2, '0')}`, `Filler ${i}`, 1980 + i, [['Comedy'], ['Drama', 'Romance'], ['Action'], ['Crime', 'Thriller'], ['Horror']][i % 5], `Director ${i}`, '7.4')),
]

async function fakeCinemeta (url: string): Promise<unknown> {
  const m = /\/meta\/movie\/(tt\d+)\.json$/.exec(url)
  if (m) return { meta: METAS.find(x => x.id === m[1]) }
  if (url.includes('/catalog/movie/top.json')) return { metas: METAS }
  return { metas: [] }
}

const opened: Array<{ dir: string; db: DatabaseSync }> = []

beforeEach(() => { opened.length = 0 })
afterEach(() => {
  for (const o of opened) { o.db.close(); rmSync(o.dir, { recursive: true, force: true }) }
})

/** A fresh database with one profile that liked Shawshank, The Godfather and Die Hard. */
async function setup (cf: CfModel | null) {
  const dir = mkdtempSync(join(tmpdir(), 'nexttupp-svc-'))
  const db = openDb(join(dir, 'nexttupp.db'))
  opened.push({ dir, db })
  const store = new SqliteTasteStore(db)
  const items = new ItemCache(db, { baseUrl: 'https://cinemeta.test', fetch: fakeCinemeta, intervalMs: 0, concurrency: 8 })
  await items.catalogPage('movie', 'top')
  const reco = new RecoService({ store, items, cf })
  const me = store.defaultProfile()
  for (const id of [SHAWSHANK, GODFATHER, DIE_HARD]) store.setRating(me.id, { id, type: 'movie' }, 1)
  await reco.warm(me.id)
  return { store, reco, me }
}

const topIds = (home: HomeResponse) => home.rows.find(r => r.kind === 'top')?.items.map(i => i.id) ?? []

describe('RecoService', () => {
  it('works with no CF model', async () => {
    const { reco, me } = await setup(null)
    const home = reco.home(me)
    expect(home.coldStart).toBe(false)
    expect(topIds(home)).toContain(GODFATHER2)
    expect(topIds(home)).not.toContain(GODFATHER)
    expect(reco.taste(me).cf).toEqual({ available: false, covered: 0 })
  })

  it('blends a real CfModel in: co-liked titles rise and the disliked-by-fans one sinks', async () => {
    const cf = parseCf(readFileSync(join(import.meta.dirname, '..', 'reco', '__fixtures__', 'tiny-cf.bin')))
    const plain = await setup(null)
    const without = topIds(plain.reco.home(plain.me))
    const { reco, me } = await setup(cf)
    const home = reco.home(me)
    const ids = topIds(home)
    expect(ids[0]).toBe(GODFATHER2)
    const pos = (list: string[], id: string) => (list.indexOf(id) === -1 ? 99 : list.indexOf(id))
    expect(pos(ids, BEFORE_SUNRISE)).toBeGreaterThanOrEqual(pos(without, BEFORE_SUNRISE))
    const g2 = home.rows.find(r => r.kind === 'top')!.items[0]
    expect(g2.reason.text).toMatch(/Godfather|Coppola/)
    expect(reco.taste(me).cf).toEqual({ available: true, covered: 3 })
  })

  it('picks up a CF model that appears after start-up without serving a stale cached home', async () => {
    const { reco, me } = await setup(null)
    reco.prewarm()
    const before = reco.home(me)
    reco.setCf(parseCf(readFileSync(join(import.meta.dirname, '..', 'reco', '__fixtures__', 'tiny-cf.bin'))))
    const after = reco.home(me)
    expect(after.rows).not.toBe(before.rows)
    expect(topIds(after)[0]).toBe(GODFATHER2)
    expect(reco.taste(me).cf).toEqual({ available: true, covered: 3 })
  })

  it('answers "more like this" and onboarding, and serves home from cache when nothing changed', async () => {
    const { reco, me } = await setup(null)
    const similar = await reco.similar(me, { id: GODFATHER, type: 'movie' })
    expect(similar[0].id).toBe(GODFATHER2)
    expect(similar[0].reason.text).toBe('Also from Francis Ford Coppola')
    const onboarding = reco.onboarding(me)
    expect(onboarding.items.map(i => i.id)).not.toContain(GODFATHER)
    expect(onboarding.rated).toBe(3)
    expect(onboarding.positives).toBe(3)
    const a = reco.home(me)
    const b = reco.home(me)
    expect(b.rows).toBe(a.rows)
  })

  it('counts onboarding progress in positives, not ratings: dislikes don\'t move it', async () => {
    const { store, reco } = await setup(null)
    const other = store.createProfile({ name: 'Other' })
    store.setRating(other.id, { id: GODFATHER, type: 'movie' }, -1, 'onboarding')
    store.setRating(other.id, { id: DIE_HARD, type: 'movie' }, -1, 'onboarding')
    store.setRating(other.id, { id: SHAWSHANK, type: 'movie' }, 1, 'onboarding')
    const o = reco.onboarding(other)
    expect(o.rated).toBe(3)
    expect(o.positives).toBe(1)
    expect(o.target).toBe(3)
  })
})

describe('GET /api/me/marks (the buttons under each poster)', () => {
  it('lists every rating and My List entry, without cleared ones', async () => {
    const { store, reco, me } = await setup(null)
    const app = Fastify()
    registerTasteRoutes(app, store, reco)
    store.setRating(me.id, { id: DIE_HARD, type: 'movie' }, 0)
    store.setRating(me.id, { id: BEFORE_SUNRISE, type: 'movie' }, -1)
    store.setInList(me.id, { id: GODFATHER2, type: 'movie' }, true)
    store.setInList(me.id, { id: SHAWSHANK, type: 'movie' }, true)
    store.setInList(me.id, { id: SHAWSHANK, type: 'movie' }, false)
    const res = await app.inject({ method: 'GET', url: '/api/me/marks' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ratings: { [SHAWSHANK]: 1, [GODFATHER]: 1, [BEFORE_SUNRISE]: -1 }, list: [GODFATHER2] })
    await app.close()
  })
})
