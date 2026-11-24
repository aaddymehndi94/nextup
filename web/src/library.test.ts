import { describe, expect, it } from 'vitest'
import type { LibraryItem } from './api.ts'
import { downloadOf } from './library.ts'

// Play on a title's page plays the viewer's download of that episode or film when there is one.

const item = (id: string, streamId: string, progress: number, extra: Partial<LibraryItem> = {}): LibraryItem => ({
  id, infoHash: `hash-${id}`, fileIdx: 0, fileName: `${id}.mkv`, title: id, type: 'series', imdbId: 'tt0165598',
  streamId, addedAt: 0, stats: null, progress, ...extra,
})

describe('the download Play uses', () => {
  const items = [item('a', 'tt0165598:3:1', 0.4), item('b', 'tt0165598:3:1', 1), item('c', 'tt0165598:3:2', 1)]

  it('is the download of that very episode, the most complete one', () => {
    expect(downloadOf(items, 'tt0165598:3:1')?.id).toBe('b')
    expect(downloadOf(items, 'tt0165598:3:2')?.id).toBe('c')
  })

  it('counts a download in progress by how far it has got', () => {
    const live = item('d', 'tt0165598:3:3', 0, { stats: { progress: 0.9 } as LibraryItem['stats'] })
    expect(downloadOf([item('e', 'tt0165598:3:3', 0.2), live], 'tt0165598:3:3')?.id).toBe('d')
  })

  it('is none for an episode not downloaded, or one still waiting for its torrent', () => {
    expect(downloadOf(items, 'tt0165598:3:4')).toBeNull()
    expect(downloadOf([item('f', 'tt0165598:3:4', 0, { pending: true })], 'tt0165598:3:4')).toBeNull()
  })
})
