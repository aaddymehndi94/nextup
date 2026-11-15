import { describe, expect, it } from 'vitest'
import { readableAccent } from './colour.ts'

describe('a colour picked for buttons and highlights', () => {
  it('stays as it is when dark text already reads on it', () => {
    expect(readableAccent('#ffd166')).toBe('#ffd166')
    expect(readableAccent('#FFFFFF')).toBe('#ffffff')
  })

  it('is lightened towards white until dark text reads on it', () => {
    expect(readableAccent('#000000')).toBe('#999999')
  })

  it('keeps its hue while lightening', () => {
    const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(readableAccent('#0000ff')!.slice(i, i + 2), 16))
    expect(b).toBe(255)
    expect(r).toBe(g)
    expect(r).toBeLessThan(255)
  })

  it('refuses what isn’t a colour', () => {
    expect(readableAccent('red')).toBeNull()
    expect(readableAccent('#12345')).toBeNull()
  })
})
