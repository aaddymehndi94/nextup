import { describe, expect, it } from 'vitest'
import { parseRange } from './range.ts'
import { pickFile } from './engine.ts'

describe('parseRange', () => {
  it('handles open, closed, suffix and absent ranges', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('rejects unsatisfiable or malformed ranges', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange('bytes=5-2', 1000)).toBe('invalid')
    expect(parseRange('bytes=-', 1000)).toBe('invalid')
    expect(parseRange('items=0-1', 1000)).toBe('invalid')
  })
})

describe('pickFile', () => {
  const files = [
    { name: 'sample.mkv', length: 50 },
    { name: 'Show.S01E01.mkv', length: 900 },
    { name: 'Show.S01E02.mkv', length: 1000 },
    { name: 'readme.nfo', length: 1 },
  ]
  it('uses the provider file index when it points at a video', () => {
    expect(pickFile(files, 1)).toBe(1)
  })
  it('prefers a file-name match when the index disagrees', () => {
    expect(pickFile(files, 1, 'Show.S01E02.mkv')).toBe(2)
  })
  it('falls back to the largest video', () => {
    expect(pickFile(files)).toBe(2)
    expect(pickFile(files, 3)).toBe(2)
  })
  it('returns -1 when there is no video', () => {
    expect(pickFile([{ name: 'a.txt', length: 5 }])).toBe(-1)
  })
})
