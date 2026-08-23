import { describe, expect, it } from 'vitest'
import { uuidv7 } from '../src/uuidv7'

describe('uuidv7 client identifiers', () => {
  it('encodes the timestamp, version, and RFC variant', () => {
    const id = uuidv7(1700000000123, (bytes) => bytes.fill(0))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id.replaceAll('-', '').slice(0, 12)).toBe('018bcfe5687b')
  })

  it('generates unique values when called repeatedly', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv7()))
    expect(ids.size).toBe(100)
  })
})
