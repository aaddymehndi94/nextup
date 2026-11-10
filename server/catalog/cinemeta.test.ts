import { describe, expect, it } from 'vitest'
import { decodeEntities } from './cinemeta.ts'

describe('decodeEntities', () => {
  it('decodes named and numeric entities and leaves plain text alone', () => {
    expect(decodeEntities('Judith O&apos;Dea')).toBe("Judith O'Dea")
    expect(decodeEntities('Tom &amp; Jerry &#8211; &#x2019;s')).toBe('Tom & Jerry – ’s')
    expect(decodeEntities('R&D &unknown; ok')).toBe('R&D &unknown; ok')
    expect(decodeEntities(undefined)).toBeUndefined()
  })
})
