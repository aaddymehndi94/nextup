import { describe, expect, it } from 'vitest'
import { BILLBOARD_POOL, chooseFeatured, rememberFeatured } from './billboard.ts'

const picks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `tt${i}` }))

/** Opens Home `times` times and returns what the billboard showed each time. */
function visits (candidates: Array<{ id: string }>, times: number, recent: string[] = []): string[] {
  const shown: string[] = []
  for (let i = 0; i < times; i++) {
    const pick = chooseFeatured(candidates, recent)!
    shown.push(pick.id)
    recent = rememberFeatured(recent, pick.id)
  }
  return shown
}

describe('the billboard rotates through the top picks', () => {
  it('shows the top pick first, then a different one each time Home opens', () => {
    expect(visits(picks(5), 3)).toEqual(['tt0', 'tt1', 'tt2'])
  })

  it('once every top pick has had a turn, shows the one featured longest ago', () => {
    expect(visits(picks(3), 5)).toEqual(['tt0', 'tt1', 'tt2', 'tt0', 'tt1'])
  })

  it('features a new top pick before repeating one', () => {
    const recent = ['tt0', 'tt1', 'tt2']
    expect(chooseFeatured([{ id: 'tt1' }, { id: 'new' }, { id: 'tt0' }], recent)?.id).toBe('new')
  })

  it('stays among the strongest picks', () => {
    const shown = visits(picks(30), 3 * BILLBOARD_POOL)
    expect(new Set(shown).size).toBe(BILLBOARD_POOL)
    expect(shown.every(id => Number(id.slice(2)) < BILLBOARD_POOL)).toBe(true)
  })

  it('has nothing to show without picks', () => {
    expect(chooseFeatured([], ['tt0'])).toBeNull()
  })

  it('keeps a short memory, newest last', () => {
    let recent: string[] = []
    for (let i = 0; i < 40; i++) recent = rememberFeatured(recent, `tt${i}`)
    expect(recent).toHaveLength(2 * BILLBOARD_POOL)
    expect(recent.at(-1)).toBe('tt39')
    expect(rememberFeatured(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
  })
})
