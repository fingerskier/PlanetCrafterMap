import { describe, expect, it } from 'vitest'
import { isSceneId, planetHash } from '../src/lib/planets.js'

describe('planetHash', () => {
  // Values observed in real saves / asserted by independent implementations.
  it.each([
    ['Prime', -1140328421],
    ['Humble', -486276833],
    ['Selenea', -1016990411],
    ['Aqualis', -1291310150],
    ['Toxicity', 110910045],
    ['Skeo', -440810600],
    ['Container1', 1768717124],
    ['CraftStation1', 769498401],
    ['QuartzCraftStation1', -1824094490],
  ])('%s -> %i', (id, hash) => expect(planetHash(id)).toBe(hash))

  it('is case-sensitive', () => expect(planetHash('prime')).toBe(-1140369413))
  it('stops at NUL', () => expect(planetHash('Prime\0junk')).toBe(planetHash('Prime')))
})

describe('isSceneId', () => {
  it('bounds', () => {
    expect(isSceneId(99_999_999)).toBe(false)
    expect(isSceneId(100_000_000)).toBe(true)
    expect(isSceneId(199_999_999)).toBe(true)
    expect(isSceneId(200_000_000)).toBe(false)
    expect(isSceneId(1.5e8 + 0.5)).toBe(false)
  })
})
