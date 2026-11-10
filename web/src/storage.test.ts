import { describe, expect, it } from 'vitest'
import { readKey, writeKey } from './storage.ts'

function memory () {
  const m = new Map<string, string>()
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
  }
}

describe('storage keys after the nextup → nexttupp rename', () => {
  it('reads a value saved under the old prefix', () => {
    const s = memory()
    s.setItem('nextup:progress:tt0063350', '{"t":120}')
    expect(readKey('progress:tt0063350', s)).toBe('{"t":120}')
  })

  it('prefers the new key over the old one', () => {
    const s = memory()
    s.setItem('nextup:subs-lang', 'fr')
    s.setItem('nexttupp:subs-lang', 'en')
    expect(readKey('subs-lang', s)).toBe('en')
  })

  it('moves the value to the new key on write', () => {
    const s = memory()
    s.setItem('nextup:progress:tt1', '{"t":30}')
    writeKey('progress:tt1', '{"t":35}', s)
    expect([...s.map.entries()]).toEqual([['nexttupp:progress:tt1', '{"t":35}']])
  })

  it('clears both keys when the value is null', () => {
    const s = memory()
    s.setItem('nextup:subs-lang', 'fr')
    s.setItem('nexttupp:subs-lang', 'fr')
    writeKey('subs-lang', null, s)
    expect(s.map.size).toBe(0)
  })

  it('returns null without storage', () => {
    expect(readKey('x', null)).toBeNull()
  })
})
