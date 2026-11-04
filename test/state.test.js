import { describe, expect, it } from 'vitest'
import { decodeHash, encodeHash } from '../src/lib/state.js'

describe('encodeHash', () => {
  it('matches the documented example', () => {
    expect(encodeHash({ world: 'prime', x: 10, z: -20, zoom: -1.5, layers: ['iron', 'cobalt'], pin: { x: 10, z: -20 } }))
      .toBe('#w=prime&x=10&z=-20&zm=-1.5&l=iron,cobalt&p=10,-20')
  })

  it('uses a fixed key order whatever the input order', () => {
    const state = { pin: { x: 1, z: 2 }, layers: ['iron'], zoom: 0, z: 3, x: 4, world: 'humble' }
    expect(encodeHash(state)).toBe('#w=humble&x=4&z=3&zm=0&l=iron&p=1,2')
  })

  it('rounds the center to units, the pin to 0.1 and the zoom to 0.01', () => {
    expect(encodeHash({ x: 10.49, z: -20.5, zoom: -1.254, pin: { x: 1.26, z: -0.04 } }))
      .toBe('#x=10&z=-20&zm=-1.25&p=1.3,0')
  })

  it('never writes -0', () => {
    expect(encodeHash({ x: -0.2, z: -0, zoom: -0.001, pin: { x: -0.01, z: -0 } })).toBe('#x=0&z=0&zm=0&p=0,0')
  })

  it('omits missing and invalid values', () => {
    expect(encodeHash({})).toBe('')
    expect(encodeHash({ world: 'bad slug!', x: NaN, z: Infinity, zoom: 99, pin: { x: 1, z: NaN } })).toBe('')
    expect(encodeHash({ world: 'prime', x: 5 })).toBe('#w=prime&x=5')
  })

  it('tells "no layers" (l=) from "default layers" (no l)', () => {
    expect(encodeHash({ world: 'prime', layers: [] })).toBe('#w=prime&l=')
    expect(encodeHash({ world: 'prime' })).toBe('#w=prime')
  })

  it('drops invalid and duplicate layer ids', () => {
    expect(encodeHash({ layers: ['iron', 'Iron', 'a,b', '', 'iron', 'golden-effigy'] })).toBe('#l=iron,golden-effigy')
  })

  it('is stable: encode(decode(encode(s))) === encode(s)', () => {
    const once = encodeHash({ world: 'skeo', x: -1234.56, z: 6300.4, zoom: 2.75, layers: ['ice', 'iron'], pin: { x: 0.05, z: -9.99 } })
    expect(encodeHash(decodeHash(once))).toBe(once)
  })
})

describe('decodeHash', () => {
  it('reads the documented example', () => {
    expect(decodeHash('#w=prime&x=10&z=-20&zm=-1.5&l=iron,cobalt&p=10,-20')).toEqual({
      world: 'prime', x: 10, z: -20, zoom: -1.5, layers: ['iron', 'cobalt'], pin: { x: 10, z: -20 },
    })
  })

  it('round-trips a full state', () => {
    const state = { world: 'aqualis', x: -3000, z: 4000, zoom: -4.25, layers: ['iron', 'other'], pin: { x: 12.3, z: -45.6 } }
    expect(decodeHash(encodeHash(state))).toEqual(state)
  })

  it('accepts a hash with or without #, in any key order', () => {
    expect(decodeHash('zm=1&w=humble')).toEqual({ world: 'humble', zoom: 1 })
    expect(decodeHash('#zm=1&w=humble')).toEqual({ world: 'humble', zoom: 1 })
  })

  it.each(['', '#', '#&&&', '#=1', '#w', '#noequals&=x'])('returns {} for %j', (hash) => {
    expect(decodeHash(hash)).toEqual({})
  })

  it.each([undefined, null, 42, {}])('returns {} for non-string %j', (hash) => {
    expect(decodeHash(hash)).toEqual({})
  })

  it('ignores unknown keys', () => {
    expect(decodeHash('#foo=bar&w=prime&utm_source=x&X=5')).toEqual({ world: 'prime' })
  })

  it('ignores invalid numbers key by key', () => {
    expect(decodeHash('#x=abc&z=12&zm=0x10')).toEqual({ z: 12 })
    expect(decodeHash('#x=&z=Infinity&zm=NaN')).toEqual({})
    expect(decodeHash('#x=1e9&z=-5&zm=100')).toEqual({ z: -5 })
    expect(decodeHash('#x= 7 ')).toEqual({ x: 7 })
  })

  it('ignores malformed percent escapes', () => {
    expect(decodeHash('#w=%E0%A4%A&x=3')).toEqual({ x: 3 })
  })

  it('decodes percent-escaped values', () => {
    expect(decodeHash('#w=pr%69me&l=iron%2Ccobalt')).toEqual({ world: 'prime', layers: ['iron', 'cobalt'] })
  })

  it('passes an unknown but well-formed world through (the caller resolves it)', () => {
    expect(decodeHash('#w=atlantis')).toEqual({ world: 'atlantis' })
    expect(decodeHash('#w=Prime')).toEqual({ world: 'Prime' })
  })

  it('rejects world values that cannot be a slug or id', () => {
    expect(decodeHash('#w=%3Cscript%3E')).toEqual({})
    expect(decodeHash('#w=' + 'a'.repeat(100))).toEqual({})
    expect(decodeHash('#w=%20')).toEqual({})
  })

  it('keeps l= as "no layers" and filters bad ids', () => {
    expect(decodeHash('#l=')).toEqual({ layers: [] })
    expect(decodeHash('#l=iron,,IRON,iron,golden-effigy,-bad,a b')).toEqual({ layers: ['iron', 'golden-effigy'] })
  })

  it('requires the pin to be exactly two valid numbers', () => {
    expect(decodeHash('#p=1,2')).toEqual({ pin: { x: 1, z: 2 } })
    expect(decodeHash('#p=1')).toEqual({})
    expect(decodeHash('#p=1,2,3')).toEqual({})
    expect(decodeHash('#p=1,z')).toEqual({})
    expect(decodeHash('#p=')).toEqual({})
  })

  it('lets the last occurrence of a key win', () => {
    expect(decodeHash('#w=prime&w=humble')).toEqual({ world: 'humble' })
  })

  it('normalizes -0', () => {
    expect(Object.is(decodeHash('#x=-0').x, 0)).toBe(true)
  })
})
