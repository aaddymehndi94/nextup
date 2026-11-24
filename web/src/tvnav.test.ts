import { describe, expect, it } from 'vitest'
import { pickNext, pickOnPage, type Box } from './tvnav.ts'

// Moving focus with a TV remote's arrow keys: from the focused box, the nearest box in that direction,
// preferring ones lined up with it.

const box = (x: number, y: number, w = 100, h = 40): Box => ({ left: x, top: y, right: x + w, bottom: y + h })

describe('the remote’s arrow keys', () => {
  // A billboard button over a row of posters, a masthead above.
  const play = box(40, 330, 140, 48)
  const trailer = box(200, 330, 48, 48)
  const posters = [box(40, 430, 250, 140), box(305, 430, 250, 140), box(570, 430, 250, 140), box(835, 430, 250, 140)]
  const search = box(540, 16, 280, 44)
  const tabs = [box(190, 26, 60, 24), box(260, 26, 60, 24)]
  const all = [play, trailer, ...posters, search, ...tabs]

  it('Down from a button goes to the poster under it, not the one further along', () => {
    expect(all[pickNext(play, all, 'down')!]).toBe(posters[0])
    expect(all[pickNext(trailer, all, 'down')!]).toBe(posters[0])
  })

  it('Right along a row goes to the next card, including one past the edge of the screen', () => {
    expect(all[pickNext(posters[0], all, 'right')!]).toBe(posters[1])
    expect(all[pickNext(posters[2], all, 'right')!]).toBe(posters[3])
    expect(pickNext(posters[3], all, 'right')).toBeNull()
  })

  it('Up from the billboard reaches the masthead, the nearest item first', () => {
    expect(all[pickNext(play, all, 'up')!]).toBe(tabs[0])
    // From further along the row: the billboard's controls (the nearest line), the one most in line with it.
    expect(all[pickNext(posters[2], all, 'up')!]).toBe(trailer)
    expect(all[pickNext(posters[0], all, 'up')!]).toBe(play)
  })

  it('Left from the first item goes nowhere, and nothing counts itself', () => {
    expect(pickNext(posters[0], all, 'left')).toBeNull()
    expect(all[pickNext(trailer, all, 'left')!]).toBe(play)
  })

  it('Left and Right stay in their row, even when something further down is a little nearer', () => {
    const music = box(387, 21, 42, 24)
    const myList = box(453, 21, 50, 24)
    const cardAction = box(428, 850, 24, 24)
    expect([music, myList, cardAction][pickNext(music, [music, myList, cardAction], 'right')!]).toBe(myList)
    // Nothing else in the row: stay put rather than drop to another row.
    expect(pickNext(music, [music, cardAction], 'right')).toBeNull()
  })

  it('Up goes to the row above even when it’s under the masthead; the masthead only from the top of the page', () => {
    // Measured on the TV, scrolled 1277 px down: the focused poster centred, the row above ending under the
    // fixed masthead, which ends at 76.
    const poster = box(748, 129, 132, 283)
    const rowAbove = { box: box(748, -230, 132, 283), fixed: false }
    const search = { box: box(534, 16, 280, 44), fixed: true }
    expect(pickOnPage({ box: poster, fixed: false }, [search, rowAbove], 'up', 1277)).toBe(1)
    // At the top of the page, the masthead is what's above the first row.
    expect(pickOnPage({ box: box(38, 300, 140, 48), fixed: false }, [search], 'up', 0)).toBe(0)
    // And Down from the masthead goes to what's under it on screen, wherever the page is scrolled.
    expect(pickOnPage(search, [{ box: box(40, 129, 132, 283), fixed: false }], 'down', 1277)).toBe(0)
  })

  it('skips boxes that only overlap the starting one', () => {
    const wide = box(0, 0, 1000, 600)
    expect(pickNext(box(10, 10), [wide, box(10, 100)], 'down')).toBe(1)
  })
})
