import { describe, expect, it } from 'vitest'
import type { Torrent, TorrentFile } from 'webtorrent'
import { StreamReader } from './reader.ts'

const MB = 1024 * 1024

function fakeTorrent () {
  const selected: Array<{ from: number; to: number; priority: number }> = []
  const torrent = {
    pieceLength: MB, destroyed: false,
    _select: (from: number, to: number, priority: number) => { selected.push({ from, to, priority }) },
    _deselect: () => {},
    on: () => {}, off: () => {},
  }
  return { torrent: torrent as unknown as Torrent, selected }
}
const file = { offset: 0 } as TorrentFile

describe('reading a file from the swarm', () => {
  it('a stream fetches a wide window urgently and the rest of the file behind it', () => {
    const { torrent, selected } = fakeTorrent()
    const r = new StreamReader(torrent, file, 0, 1000 * MB - 1)
    expect(selected).toEqual([{ from: 0, to: 47, priority: 2 }, { from: 48, to: 999, priority: 0 }])
    r.destroy()
  })

  it('a glance (one still) fetches only the few pieces around where it reads, and nothing after', () => {
    const { torrent, selected } = fakeTorrent()
    const r = new StreamReader(torrent, file, 500 * MB, 1000 * MB - 1, { glance: true })
    expect(selected).toEqual([{ from: 500, to: 503, priority: 2 }])
    r.destroy()
  })
})
