import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DownloadFolders } from './folders.ts'

const HASH = 'c'.repeat(40)

describe('DownloadFolders', () => {
  it('saves new downloads in the chosen folder and still finds earlier ones where they are', () => {
    const data = mkdtempSync(join(tmpdir(), 'folders-'))
    const f = new DownloadFolders(data)
    expect(f.current).toBe(join(data, 'downloads'))
    mkdirSync(join(f.current, HASH))
    const big = join(data, 'big-disk')
    f.set(big)
    expect(existsSync(big)).toBe(true)
    expect(f.current).toBe(big)
    expect(f.of(HASH)).toBe(join(data, 'downloads', HASH)) // already saved: stays where it is
    expect(f.of('d'.repeat(40))).toBe(join(big, 'd'.repeat(40))) // new: the chosen folder
    expect(f.all()).toEqual([big, join(data, 'downloads')])
    // It's remembered across restarts.
    expect(new DownloadFolders(data).of(HASH)).toBe(join(data, 'downloads', HASH))
    expect(JSON.parse(readFileSync(join(data, 'folders.json'), 'utf8')).downloadsDir).toBe(big)
  })

  it('forgets an earlier folder once nothing is left in it, and goes back to the default', () => {
    const data = mkdtempSync(join(tmpdir(), 'folders-'))
    const f = new DownloadFolders(data)
    f.set(join(data, 'elsewhere'))
    expect(f.all()).toEqual([join(data, 'elsewhere')]) // the default held nothing
    mkdirSync(join(f.current, HASH))
    f.set(f.default)
    expect(f.current).toBe(join(data, 'downloads'))
    expect(f.all()).toEqual([join(data, 'downloads'), join(data, 'elsewhere')])
    expect(() => f.set('')).toThrow(/full path/) // the route turns '' into the default
  })

  it('refuses a relative path, and a folder inside a download', () => {
    const data = mkdtempSync(join(tmpdir(), 'folders-'))
    const f = new DownloadFolders(data)
    mkdirSync(join(f.current, HASH))
    expect(() => f.set('relative/path')).toThrow(/full path/)
    expect(() => f.set(join(f.current, HASH, 'sub'))).toThrow(/inside a download/)
    f.set(f.default)
    expect(f.current).toBe(join(data, 'downloads'))
  })
})
