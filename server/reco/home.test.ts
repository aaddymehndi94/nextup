import { describe, expect, it } from 'vitest'
import type { HomeRow } from '../../shared/types.ts'
import { ContentIndex } from './content.ts'
import { buildHome, type HomeInput, moreForRow } from './home.ts'
import { seriesLabel } from './labels.ts'
import { dupKey, explore, freshness, prepare, scoreAll } from './rank.ts'
import { computeSignals, DAY, exclusions, strength } from './signals.ts'
import type { ItemMeta, TasteSnapshot } from './types.ts'

// The home feed's paging, discover rows, "New & popular" and the guard against cartoons in an adult feed.

const NOW = Date.UTC(2026, 5, 1)
const iso = (t: number) => new Date(t).toISOString()

let seq = 0
function item (name: string, genres: string[], over: Partial<ItemMeta> = {}): ItemMeta {
  seq++
  return {
    id: `tt${8_000_000 + seq}`, type: 'movie', name, year: 2010, released: '2010-06-01', poster: 'p', genres,
    cast: [`Actor ${seq}`], directors: [`Director ${seq}`], writers: [], countries: ['United States'],
    imdbRating: 7.4, popularity: 20, runtime: 110, fetchedAt: 0, ...over,
  }
}
// Distinct words, not numbers: "Frontier 2" would be a sequel of "Frontier 1" (one family, one per screen).
const WORDS = ['Alder', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fjord', 'Grove', 'Heath', 'Inlet', 'Juniper', 'Kestrel', 'Lark', 'Marsh', 'Nettle',
  'Oriole', 'Pine', 'Quarry', 'Rowan', 'Sedge', 'Thistle', 'Umber', 'Vale', 'Willow', 'Yarrow']
const nm = (prefix: string, i: number) => `${prefix} ${WORDS[i]}`
const many = (prefix: string, n: number, genres: string[], over: (i: number) => Partial<ItemMeta> = () => ({})) =>
  Array.from({ length: n }, (_, i) => item(nm(prefix, i), genres, { year: 1995 + i, released: `${1995 + i}-03-01`, ...over(i) }))

const CATALOG: ItemMeta[] = [
  ...many('Kitchen Sink', 24, ['Drama'], i => ({ description: 'A family drama about a small town.', cast: ['Ada Rowe', `Actor x${i}`] })),
  ...many('Frontier', 14, ['Western'], () => ({ imdbRating: 8.1, description: 'A gunslinger rides into a frontier town.' })),
  ...many('Seoul Night', 14, ['Crime', 'Thriller'], () => ({ imdbRating: 7.9, countries: ['South Korea'], description: 'A detective hunts a killer.' })),
  ...many('Toon Quest', 8, ['Animation', 'Adventure', 'Comedy'], () => ({ type: 'series', imdbRating: 8.6, popularity: 400, description: 'Kids solve mysteries.' })),
  ...many('This Year', 10, ['Drama', 'Comedy'], i => ({ year: 2026, released: iso(NOW - (40 + 10 * i) * DAY), imdbRating: 6.8, popularity: 100 })),
  item('Fresh Hit', ['Comedy'], { year: 2026, released: iso(NOW - 20 * DAY), imdbRating: 6.8, popularity: 300 }),
  item('Last Year Hit', ['Comedy'], { year: 2025, released: iso(NOW - 330 * DAY), imdbRating: 6.8, popularity: 300 }),
]
const byName = (name: string) => CATALOG.find(i => i.name === name)!

const empty = (): TasteSnapshot => ({ ratings: [], list: [], progress: [], dismissals: [], prefs: new Map() })
const likes = (names: string[], prefs = new Map<string, 1 | -1>()): TasteSnapshot =>
  ({ ...empty(), prefs, ratings: names.map(n => ({ id: byName(n).id, type: byName(n).type, value: 1 as const, at: NOW - DAY })) })
const DRAMA_FAN = likes([0, 1, 2, 3, 4, 5].map(i => nm('Kitchen Sink', i)))

function input (snap: TasteSnapshot): HomeInput {
  const signals = computeSignals(snap, NOW)
  return {
    index: new ContentIndex(CATALOG), signals, snapshot: snap, exclude: exclusions(snap), prefs: snap.prefs, cf: null,
    impressions: new Map(), confidence: strength(signals).confidence, now: NOW, seed: 3,
  }
}
const ids = (rows: HomeRow[]) => rows.flatMap(r => r.items.map(i => i.id))
const nameOf = (id: string) => CATALOG.find(i => i.id === id)!.name

describe('home paging', () => {
  it('has rows below the first screen, and counts only the first screen as shown', () => {
    const out = buildHome(input(DRAMA_FAN))
    expect(out.rows.length).toBeGreaterThan(out.firstPage)
    const first = new Set(ids(out.rows.slice(0, out.firstPage)))
    expect(out.shown.length).toBeGreaterThan(0)
    expect(out.shown.every(id => first.has(id))).toBe(true)
    expect(new Set(out.rows.map(r => r.id)).size).toBe(out.rows.length)
  })

  it('continues a row with titles it doesn\'t have yet', () => {
    const inp = input(DRAMA_FAN)
    const out = buildHome(inp)
    const top = out.rows.find(r => r.id === 'top')!
    const have = top.items.map(i => i.id)
    const more = moreForRow(inp, 'top', have)
    expect(more.length).toBeGreaterThan(0)
    expect(more.some(i => have.includes(i.id))).toBe(false)
    for (const r of out.rows.filter(r => !['continue', 'list'].includes(r.kind))) {
      const h = r.items.map(i => i.id)
      const next = moreForRow(inp, r.id, h)
      expect(next.some(i => h.includes(i.id)), r.id).toBe(false)
      expect(new Set(next.map(i => i.id)).size, r.id).toBe(next.length)
    }
    expect(moreForRow(inp, 'nonsense', [])).toEqual([])
  })
})

describe('New & popular', () => {
  it('comes right after Top picks', () => {
    const rows = buildHome(input(DRAMA_FAN)).rows
    const top = rows.findIndex(r => r.id === 'top')
    expect(rows[top + 1].id).toBe('popular')
  })

  it('puts the newest first among titles of the same standing', () => {
    const row = buildHome(input(empty())).rows.find(r => r.id === 'popular')!
    const names = row.items.map(i => i.name)
    expect(names.indexOf('Fresh Hit')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('Fresh Hit')).toBeLessThan(names.indexOf('Last Year Hit'))
  })

  it('fades freshness over the year, and gives none to the unreleased or poorly rated', () => {
    expect(freshness(byName('Fresh Hit'), NOW)).toBeGreaterThan(0.8)
    expect(freshness(byName('Last Year Hit'), NOW)).toBeLessThan(0.2)
    expect(freshness(byName('Fresh Hit'), NOW - 30 * DAY)).toBe(0)
    expect(freshness({ ...byName('Fresh Hit'), imdbRating: 5.2 }, NOW)).toBe(0)
  })
})

describe('discover rows', () => {
  it('offers kinds of titles the likes don\'t touch, each with the feature to answer', () => {
    const rows = buildHome(input(DRAMA_FAN)).rows.filter(r => r.kind === 'discover')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.feature?.key).toBeTruthy()
      expect(r.id).toBe(`discover:${r.feature!.key}`)
      expect(r.feature!.key).not.toMatch(/Drama/)
    }
    const keys = rows.map(r => r.feature!.key)
    expect(keys.some(k => k === 'g:Western' || k === 'c:south korea' || k.includes('Thriller') || k.includes('Crime'))).toBe(true)
  })

  it('"Not for me" removes the kind everywhere; "More like this" gives it its own row', () => {
    const no = buildHome(input(likes(DRAMA_FAN.ratings.map(r => nameOf(r.id)), new Map([['g:Western', -1]])))).rows
    expect(no.some(r => r.id === 'discover:g:Western')).toBe(false)
    expect(ids(no).some(id => CATALOG.find(i => i.id === id)!.genres.includes('Western'))).toBe(false)
    const yes = buildHome(input(likes(DRAMA_FAN.ratings.map(r => nameOf(r.id)), new Map([['g:Western', 1]])))).rows
    expect(yes.some(r => r.id === 'genre:g:Western')).toBe(true)
    expect(yes.some(r => r.id === 'discover:g:Western')).toBe(false)
  })
})

describe('cartoons in an adult feed', () => {
  it('keeps animated series out of "Something different" and Top picks for a profile that likes none', () => {
    const rows = buildHome(input(DRAMA_FAN)).rows
    const toon = (id: string) => nameOf(id).startsWith('Toon Quest')
    expect((rows.find(r => r.id === 'different')?.items ?? []).some(i => toon(i.id))).toBe(false)
    expect(rows.find(r => r.id === 'top')!.items.slice(0, 8).some(i => toon(i.id))).toBe(false)
  })

  it('lets them back once a couple are liked', () => {
    const fan = likes([...DRAMA_FAN.ratings.map(r => nameOf(r.id)), nm('Toon Quest', 0), nm('Toon Quest', 1)])
    const p = prepare(input(fan))
    expect(p.shape.animation).toBeGreaterThan(0.05)
  })
})

describe('explore', () => {
  it('skips a title whose family is already on screen (a film and its later series)', () => {
    const inp = input(DRAMA_FAN)
    const p = prepare(inp)
    const cands = scoreAll(p)
    const first = explore(p, cands, 24, new Set())
    expect(first.length).toBeGreaterThan(0)
    const pick = first[0].item
    const again = explore(p, cands, 24, new Set([`fam:${dupKey(pick.name)}`]))
    expect(again.some(c => dupKey(c.item.name) === dupKey(pick.name))).toBe(false)
  })
})

describe('seriesLabel', () => {
  it('names genre rows of series', () => {
    expect(seriesLabel('Romantic comedies')).toBe('Romantic comedy series')
    expect(seriesLabel('Crime dramas')).toBe('Crime drama series')
    expect(seriesLabel('War films')).toBe('War series')
    expect(seriesLabel('2010s Sci-Fi')).toBe('2010s Sci-Fi series')
    expect(seriesLabel('Comedy series')).toBe('Comedy series')
  })
})
