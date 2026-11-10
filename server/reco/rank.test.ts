import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HomeRow } from '../../shared/types.ts'
import { ContentIndex } from './content.ts'
import { buildHome, type HomeInput, onboardingItems, similarItems } from './home.ts'
import { diversify, dupKey, isRecommendable, prepare, scoreAll } from './rank.ts'
import { computeSignals, DAY, exclusions, strength } from './signals.ts'
import { summarizeTaste } from './taste.ts'
import type { CfData, ItemMeta, ProgressRow, TasteSnapshot } from './types.ts'

const NOW = Date.UTC(2026, 5, 1)

// ---- A small synthetic catalog with clear clusters -------------------------------------------

let seq = 0
function item (name: string, genres: string[], over: Partial<ItemMeta> = {}): ItemMeta {
  seq++
  return {
    id: `tt${9_000_000 + seq}`, type: 'movie', name, year: 2005, released: '2005-06-01', poster: 'p', genres,
    cast: [`Actor ${seq}`], directors: [`Director ${seq}`], writers: [], countries: ['United States'],
    imdbRating: 7.2, popularity: 10, runtime: 110, fetchedAt: 0, ...over,
  }
}

const lind = (name: string, year: number) => item(name, ['Drama', 'Romance'], { year, directors: ['Ana Lind'], cast: ['Eva Moss', 'Tom Hale'], description: 'Two strangers meet on a night train and talk until dawn.', imdbRating: 7.9 })
const hart = (name: string, year: number) => item(name, ['Action', 'Thriller'], { year, directors: ['Rex Hart'], cast: ['Max Stone'], description: 'A cop takes on terrorists in a skyscraper.', popularity: 30 })

const CATALOG: ItemMeta[] = [
  lind('Night Train', 1995), lind('Dawn Again', 2004), lind('Last Light', 2013), lind('Quiet Hours', 2018),
  ...['Paper Moons', 'Letters Home', 'Small Rooms', 'The Long Walk', 'Harbour', 'Slow Summer', 'Two Cities', 'After Rain']
    .map((n, i) => item(n, ['Drama', 'Romance'], { year: 1995 + i * 3, description: 'A tender love story between two people who meet again years later.' })),
  hart('Tower Siege', 1988), hart('Blast Zone', 1991), hart('Blast Zone 2', 1994), hart('Blast Zone: Part Three', 1997),
  ...['Hard Target', 'Full Throttle', 'Bullet Rain', 'Night Raid', 'Steel Run', 'Red Line', 'Iron Fist', 'Fast Lane']
    .map((n, i) => item(n, ['Action', 'Thriller'], { year: 1985 + i * 2, description: 'An ex-soldier fights his way through a city of criminals.', popularity: 25 })),
  ...['The Cellar', 'Hollow', 'The Visitor', 'Grin', 'Night Shift', 'Crawlspace', 'The Pale', 'Bones']
    .map((n, i) => item(n, ['Horror', 'Thriller'], { year: 2010 + i, description: 'A family moves into a house haunted by a demon.', imdbRating: 6.5 })),
  ...['Big Day', 'Office Party', 'Road Trip', 'The Wedding Crash', 'Neighbours', 'Lucky Break']
    .map((n, i) => item(n, ['Comedy'], { year: 2000 + i * 3, description: 'A hapless groom tries to save a wedding weekend.' })),
  ...['Red Mesa', 'Dust Riders', 'High Noon Pass', 'The Long Trail']
    .map((n, i) => item(n, ['Western'], { year: 1960 + i * 5, imdbRating: 8.5, description: 'A gunslinger rides into a frontier town.' })),
  ...['Signals', 'Deep Field', 'Arrival Point']
    .map((n, i) => item(n, ['Drama', 'Sci-Fi'], { year: 2014 + i, imdbRating: 8.0, description: 'A linguist decodes an alien message.' })),
  ...['Hearts Apart', 'Seaside Letters', 'Coming Home']
    .map((n, i) => item(n, ['Drama', 'Romance'], { type: 'series', year: 2019 + i, directors: [], writers: ['Kim Shaw'], description: 'Two former lovers reunite in a small town.' })),
  item('Bad Remake', ['Drama', 'Romance'], { imdbRating: 4.1 }),
  item('Untitled Lind Project', ['Drama', 'Romance'], { directors: ['Ana Lind'], year: 2027, released: '2027-01-01' }),
  item('Talk Tonight', ['Talk-Show'], { type: 'series' }),
]
const byName = (name: string) => CATALOG.find(i => i.name === name)!

const empty = (): TasteSnapshot => ({ ratings: [], list: [], progress: [], dismissals: [], prefs: new Map() })
const likes = (...names: string[]): TasteSnapshot => ({ ...empty(), ratings: names.map(n => ({ id: byName(n).id, type: byName(n).type, value: 1 as const, at: NOW - DAY })) })
const ROMANCE_FAN = likes('Night Train', 'Dawn Again', 'Last Light', 'Paper Moons')
const ACTION_FAN = likes('Tower Siege', 'Blast Zone', 'Hard Target', 'Full Throttle')

function input (snap: TasteSnapshot, over: Partial<HomeInput> = {}): HomeInput {
  const signals = computeSignals(snap, NOW)
  return {
    index: new ContentIndex(CATALOG), signals, snapshot: snap, exclude: exclusions(snap), prefs: snap.prefs, cf: null,
    impressions: new Map(), confidence: strength(signals).confidence, now: NOW, seed: 7, ...over,
  }
}

const row = (rows: HomeRow[], kind: string) => rows.find(r => r.kind === kind)
const names = (r: HomeRow | undefined) => (r?.items ?? []).map(i => i.name)
const allIds = (rows: HomeRow[]) => rows.flatMap(r => r.items.map(i => i.id))

// ---- Content similarity ---------------------------------------------------------------------

describe('content similarity', () => {
  const index = new ContentIndex(CATALOG)
  const i = (n: string) => index.indexOf(byName(n).id)!

  it('ranks a shared director above a shared genre, and a shared genre above nothing', () => {
    const sameDirector = index.sim(i('Night Train'), i('Quiet Hours'))
    const sameGenre = index.sim(i('Night Train'), i('Paper Moons'))
    const unrelated = index.sim(i('Night Train'), i('The Cellar'))
    expect(sameDirector).toBeGreaterThan(sameGenre)
    expect(sameGenre).toBeGreaterThan(unrelated)
  })

  it('simAll matches pairwise sim', () => {
    const all = index.simAll(i('Tower Siege'))
    expect(all[i('Blast Zone')]).toBeCloseTo(index.sim(i('Tower Siege'), i('Blast Zone')), 5)
    expect(all[i('Tower Siege')]).toBeCloseTo(1, 4)
  })

  it('labels features for people to read', () => {
    expect(index.label('d:ana lind')).toBe('Ana Lind')
    expect(index.label('gg:Drama+Romance')).toBe('Romantic dramas')
    expect(index.label('gd:Action@1980s')).toBe('80s action')
  })
})

// ---- Home rows ---------------------------------------------------------------------------------

describe('buildHome', () => {
  it('recommends from the liked cluster, with the liked director first', () => {
    const { coldStart, rows } = buildHome(input(ROMANCE_FAN))
    expect(coldStart).toBe(false)
    const top = row(rows, 'top')!
    expect(top.items[0].name).toBe('Quiet Hours')
    expect(top.items[0].reason.text).toMatch(/More from Ana Lind|director of/)
    const firstFive = top.items.slice(0, 5).filter(i => i.reason.kind !== 'explore')
    expect(firstFive.every(i => i.genres.includes('Romance'))).toBe(true)
  })

  it('never shows rated, disliked, dismissed or finished titles, junk, or unreleased titles', () => {
    const snap = likes('Night Train', 'Dawn Again', 'Last Light', 'Paper Moons')
    snap.ratings.push({ id: byName('Letters Home').id, type: 'movie', value: -1, at: NOW })
    snap.dismissals.push({ id: byName('Small Rooms').id, type: 'movie', reason: 'not_interested', at: NOW })
    snap.dismissals.push({ id: byName('Harbour').id, type: 'movie', reason: 'seen', at: NOW })
    const fin: ProgressRow = { id: byName('Slow Summer').id, type: 'movie', streamId: byName('Slow Summer').id, position: 6500, duration: 6600, maxPosition: 6500, watchedSec: 6400, completedAt: NOW - DAY, startedAt: NOW - 2 * DAY, updatedAt: NOW - DAY, hidden: false }
    snap.progress.push(fin)
    const ids = new Set(allIds(buildHome(input(snap)).rows))
    for (const n of ['Night Train', 'Letters Home', 'Small Rooms', 'Harbour', 'Slow Summer', 'Bad Remake', 'Untitled Lind Project', 'Talk Tonight']) {
      expect(ids.has(byName(n).id), n).toBe(false)
    }
  })

  it('gives every recommended title a readable reason', () => {
    for (const snap of [ROMANCE_FAN, ACTION_FAN, empty()]) {
      for (const r of buildHome(input(snap)).rows) {
        for (const it of r.items) {
          expect(it.reason.text.length).toBeGreaterThan(3)
          expect(it.reason.text).not.toMatch(/undefined|NaN|\[object/)
        }
      }
    }
  })

  it('shows one title per family on screen (no Blast Zone 1, 2 and 3 side by side)', () => {
    const snap = likes('Tower Siege', 'Hard Target', 'Full Throttle', 'Bullet Rain')
    const { rows } = buildHome(input(snap))
    const visible = rows.flatMap(r => r.items.slice(0, 8))
    const blast = visible.filter(i => dupKey(i.name) === 'blastzone')
    expect(blast.length).toBeLessThanOrEqual(1)
  })

  it('keeps exploration to a bounded slot in Top picks, away from disliked territory', () => {
    const snap = likes('Night Train', 'Dawn Again', 'Last Light', 'Paper Moons')
    snap.ratings.push({ id: byName('The Cellar').id, type: 'movie', value: -1, at: NOW })
    const top = row(buildHome(input(snap)).rows, 'top')!
    const wild = top.items.filter(i => i.reason.kind === 'explore')
    expect(wild.length).toBeLessThanOrEqual(Math.ceil(top.items.length / 10))
    expect(wild.every(i => !i.genres.includes('Horror'))).toBe(true)
  })

  it('falls back to popular rows and onboarding with fewer than three positives', () => {
    const { coldStart, rows } = buildHome(input(likes('Night Train', 'Tower Siege')))
    expect(coldStart).toBe(true)
    expect(rows[0].kind).toBe('onboarding')
    expect(row(rows, 'top')).toBeUndefined()
    expect(rows.some(r => r.kind === 'popular' || r.kind === 'acclaimed')).toBe(true)
  })

  it("doesn't let one accidental play take over the feed", () => {
    const before = names(row(buildHome(input(ROMANCE_FAN)).rows, 'top')).slice(0, 8)
    const snap: TasteSnapshot = { ...ROMANCE_FAN, progress: [{ id: byName('Grin').id, type: 'movie', streamId: byName('Grin').id, position: 70, duration: 5400, maxPosition: 70, watchedSec: 65, startedAt: NOW - 3600_000, updatedAt: NOW - 3600_000, hidden: false }] }
    const after = buildHome(input(snap)).rows
    expect(names(row(after, 'top')).slice(0, 8)).toEqual(before)
    expect(after.flatMap(r => r.items.slice(0, 8)).filter(i => i.genres.includes('Horror') && i.reason.kind !== 'explore')).toHaveLength(0)
  })

  it('keeps tastes per profile: one profile\'s likes don\'t leak into another\'s rows', () => {
    const romance = row(buildHome(input(ROMANCE_FAN)).rows, 'top')!
    const action = row(buildHome(input(ACTION_FAN)).rows, 'top')!
    expect(romance.items.slice(0, 4).every(i => i.genres.includes('Romance'))).toBe(true)
    expect(action.items.slice(0, 4).every(i => i.genres.includes('Action'))).toBe(true)
  })

  it('honours a blocked feature and a boosted one', () => {
    const blocked = { ...ROMANCE_FAN, prefs: new Map<string, 1 | -1>([['g:Romance', -1]]) }
    expect(buildHome(input(blocked)).rows.flatMap(r => r.items).some(i => i.genres.includes('Romance'))).toBe(false)
    const boosted = { ...ROMANCE_FAN, prefs: new Map<string, 1 | -1>([['g:Sci-Fi', 1]]) }
    const rows = buildHome(input(boosted)).rows
    const more = rows.find(r => r.id === 'genre:g:Sci-Fi')
    expect(more?.title).toBe('More Sci-Fi')
    expect(names(more)).toEqual(expect.arrayContaining(['Signals', 'Deep Field', 'Arrival Point']))
  })

  it('gives a boosted genre one row, not a "More …" row and a plain one with the same id', () => {
    // Enough romantic dramas, and enough else, for "Romantic dramas" to earn a row of its own.
    // Two-word names, so no two read as one franchise ("Romance 2" would be a sequel of "Romance 1").
    const words = ['Amber', 'Blue', 'Silent', 'Golden', 'Distant', 'Winter', 'Hidden', 'Velvet'].flatMap(a =>
      ['Harbor', 'Garden', 'Bridge', 'Season', 'Window', 'Orchard', 'Valley', 'Lantern', 'River', 'Meadow'].map(b => `${a} ${b}`))
    const more = words.map((name, i) => i % 2
      ? item(name, ['Drama', 'Romance'], { year: 1990 + (i % 30), imdbRating: 7.5, description: 'Two people fall in love over one summer.' })
      : item(name, [['Comedy'], ['Horror'], ['Western'], ['Action']][(i / 2) % 4], { year: 1990 + (i % 30), imdbRating: 7.5 }))
    const index = new ContentIndex([...CATALOG, ...more])
    const fan = likes('Night Train', 'Dawn Again', 'Last Light', 'Paper Moons', 'Letters Home', 'Harbour')
    const plain = buildHome(input(fan, { index })).rows.find(r => r.kind === 'genre')!
    expect(plain).toBeDefined()
    const key = plain.id.slice('genre:'.length)
    const rows = buildHome(input({ ...fan, prefs: new Map<string, 1 | -1>([[key, 1]]) }, { index })).rows
    const ids = rows.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rows.filter(r => r.id === plain.id).map(r => r.title)).toEqual([`More ${plain.title}`])
  })

  it('builds Continue watching from progress, with the next episode after a finished one', () => {
    const series = byName('Hearts Apart')
    const index = new ContentIndex(CATALOG.map(i => (i.id === series.id ? { ...i, episodes: [[1, 1], [1, 2], [1, 3]] as Array<[number, number]> } : i)))
    const movie = byName('Bullet Rain')
    const snap: TasteSnapshot = {
      ...ROMANCE_FAN,
      progress: [
        { id: movie.id, type: 'movie', streamId: movie.id, position: 1800, duration: 6000, maxPosition: 1800, watchedSec: 1800, startedAt: NOW - DAY, updatedAt: NOW - DAY, hidden: false },
        { id: series.id, type: 'series', streamId: `${series.id}:1:1`, season: 1, episode: 1, position: 2600, duration: 2700, maxPosition: 2600, watchedSec: 2500, completedAt: NOW - 3600_000, startedAt: NOW - 2 * 3600_000, updatedAt: NOW - 3600_000, hidden: false },
      ],
    }
    const cont = row(buildHome(input(snap, { index })).rows, 'continue')!
    expect(cont.items.map(i => i.name)).toEqual(['Hearts Apart', 'Bullet Rain'])
    expect(cont.items[0]).toMatchObject({ streamId: `${series.id}:1:2`, reason: { text: 'Next: S1E2' } })
    expect(cont.items[1].reason.text).toBe('1 h 10 min left')
  })

  it('uses CF when present, with a reason naming the liked title, and copes with it missing', () => {
    const target = byName('Signals')
    const cf: CfData = {
      scores: [{ id: target.id, score: 2.0 }, { id: byName('Harbour').id, score: 0.4 }],
      known: new Set(CATALOG.filter(i => i.type === 'movie').map(i => i.id)),
      neighbors: new Map([[byName('Night Train').id, [{ id: target.id, score: 0.9 }]]]),
    }
    const withCf = row(buildHome(input(ROMANCE_FAN, { cf })).rows, 'top')!
    const pos = withCf.items.findIndex(i => i.id === target.id)
    const without = row(buildHome(input(ROMANCE_FAN)).rows, 'top')!
    expect(pos).toBeGreaterThanOrEqual(0)
    expect(pos).toBeLessThan(without.items.findIndex(i => i.id === target.id) === -1 ? 99 : without.items.findIndex(i => i.id === target.id))
    expect(withCf.items[pos].reason.text).toMatch(/Night Train/)
  })
})

// ---- Building blocks ---------------------------------------------------------------------------

describe('diversify (MMR) and near-duplicates', () => {
  it('collapses title families', () => {
    expect(dupKey('Blast Zone: Part Three')).toBe(dupKey('Blast Zone 2'))
    expect(dupKey('The Terminator')).toBe(dupKey('Terminator 2: Judgment Day'))
    expect(dupKey('Dune: Part Two')).toBe(dupKey('Dune'))
    expect(dupKey('Before Sunset')).not.toBe(dupKey('Before Sunrise'))
  })

  it('trades relevance for variety as λ drops', () => {
    const p = prepare(input(ACTION_FAN))
    const cands = scoreAll(p)
    const genresIn = (lambda: number) => new Set(diversify(p.input.index, cands, 6, lambda).flatMap(c => c.item.genres)).size
    expect(genresIn(0.3)).toBeGreaterThan(genresIn(1))
  })

  it('filters out junk and unreleased titles', () => {
    expect(isRecommendable(byName('Talk Tonight'), NOW)).toBe(false)
    expect(isRecommendable(byName('Untitled Lind Project'), NOW)).toBe(false)
    expect(isRecommendable(byName('Bad Remake'), NOW)).toBe(false)
    expect(isRecommendable(byName('Quiet Hours'), NOW)).toBe(true)
  })
})

describe('similarItems', () => {
  it('puts the same director first and says so', () => {
    const items = similarItems(input(empty()), byName('Night Train').id, null, 5)
    expect(items.slice(0, 3).map(i => i.name).sort()).toEqual(['Dawn Again', 'Last Light', 'Quiet Hours'])
    expect(items[0].reason.text).toBe('Also from Ana Lind')
    expect(items.map(i => i.id)).not.toContain(byName('Night Train').id)
  })
})

describe('onboarding and taste summary', () => {
  it('offers varied, well-rated titles not yet rated', () => {
    const items = onboardingItems(new ContentIndex(CATALOG), ROMANCE_FAN, NOW, 1, 12)
    expect(items.length).toBeGreaterThan(5)
    expect(items.map(i => i.id)).not.toContain(byName('Night Train').id)
    expect(new Set(items.flatMap(i => i.genres)).size).toBeGreaterThanOrEqual(4)
  })

  it('summarises what the profile likes, with evidence', () => {
    const t = summarizeTaste(new ContentIndex(CATALOG), computeSignals(ROMANCE_FAN, NOW), new Map())
    expect(t.coldStart).toBe(false)
    const lind = t.likes.find(f => f.key === 'd:ana lind')
    expect(lind?.evidence).toEqual(expect.arrayContaining(['Night Train', 'Dawn Again', 'Last Light']))
    expect(t.likes.some(f => f.key === 'gg:Drama+Romance')).toBe(true)
    expect(t.summary).toMatch(/roman/i)
    expect(t.summary).toMatch(/Ana Lind/)
  })
})

describe('purity', () => {
  it('server/reco (except the CF loader) does no I/O and has no clock or randomness of its own', () => {
    const dir = import.meta.dirname
    for (const f of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'cf.ts')) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src, f).not.toMatch(/from 'node:|require\(|fetch\(|Date\.now\(|Math\.random\(|process\./)
      expect(src, f).not.toMatch(/from '\.\.\/(?!\.\.\/shared)/)
    }
  })
})
