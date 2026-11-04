import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planetHash } from '../src/lib/planets.js'
import { validateWorlds } from '../scripts/build-data.mjs'

const worldsJson = JSON.parse(readFileSync(new URL('../data/worlds.json', import.meta.url), 'utf8'))
const clone = () => structuredClone(worldsJson)

describe('data/worlds.json', () => {
  it('is pcmap-worlds/1 with exactly the six worlds, in order', () => {
    expect(worldsJson.format).toBe('pcmap-worlds/1')
    expect(worldsJson.worlds.map((w) => w.id)).toEqual(['Prime', 'Humble', 'Selenea', 'Aqualis', 'Toxicity', 'Skeo'])
  })

  it.each([
    ['Prime', 'planet', 'base', [-2000, -2000, 3000, 3000], -1140328421],
    ['Humble', 'planet', 'dlc', [-2300, -2300, 2700, 2700], -486276833],
    ['Selenea', 'moon', 'free-update', [-2000, -2000, 3000, 3000], -1016990411],
    ['Aqualis', 'moon', 'free-update', [-3000, -3000, 4000, 4000], -1291310150],
    ['Toxicity', 'planet', 'dlc', [-2200, -2200, 2800, 2800], 110910045],
    ['Skeo', 'moon', 'free-update', [-4600, -200, 1900, 6300], -440810600],
  ])('%s: %s, %s, frame %j, hash %i', (id, kind, access, frame, hash) => {
    const w = worldsJson.worlds.find((x) => x.id === id)
    expect(w).toMatchObject({ id, slug: id.toLowerCase(), name: id, kind, access, frame, hash })
    expect(w.hash).toBe(planetHash(id))
  })

  it('passes the pipeline validator', () => {
    const { worlds, errors } = validateWorlds(worldsJson)
    expect(errors).toEqual([])
    expect(worlds).toHaveLength(6)
  })
})

describe('validateWorlds', () => {
  it('rejects a hash that is not planetHash(id)', () => {
    const j = clone()
    j.worlds[1].hash = 123
    expect(validateWorlds(j).errors).toEqual([
      `worlds[1] 'Humble': hash must be planetHash("Humble") = -486276833 (got 123)`,
    ])
  })

  it('rejects duplicate ids (ignoring case) and duplicate slugs', () => {
    const j = clone()
    j.worlds[2] = { ...j.worlds[0], id: 'PRIME', hash: planetHash('PRIME') }
    const { errors, worlds } = validateWorlds(j)
    expect(worlds).toEqual([])
    expect(errors).toContain(`worlds[2] 'PRIME': duplicate id (ids must be unique ignoring case)`)
    expect(errors).toContain(`worlds[2] 'PRIME': duplicate slug 'prime'`)
  })

  it.each([
    [[0, 0, 0, 10], /minX < maxX/],
    [[0, 0, 10], /\[minX, minZ, maxX, maxZ\]/],
    [[0, 0, 10, 'x'], /finite numbers/],
    [[0, 0, 1e7, 10], /within/],
  ])('rejects frame %j', (frame, re) => {
    const j = clone()
    j.worlds[0].frame = frame
    expect(validateWorlds(j).errors.join('\n')).toMatch(re)
  })

  it('checks kind, access, slug, format and optional basemap', () => {
    const j = clone()
    j.format = 'pcmap-worlds/2'
    j.worlds[0].kind = 'asteroid'
    j.worlds[1].access = 'paid'
    j.worlds[2].slug = 'Selenea'
    j.worlds[3].basemap = { type: 'image', url: '../secret.png', bounds: [0, 0, 1, 1] }
    j.worlds[4].basemap = { type: 'image', url: 'basemaps/toxicity.png', bounds: [-2200, -2200, 2800, 2800] }
    const errors = validateWorlds(j).errors.join('\n')
    expect(errors).toMatch(/format must be "pcmap-worlds\/1"/)
    expect(errors).toMatch(/'Prime': kind must be one of planet, moon/)
    expect(errors).toMatch(/'Humble': access must be one of base, dlc, free-update/)
    expect(errors).toMatch(/'Selenea': slug must be a lowercase slug/)
    expect(errors).toMatch(/'Aqualis': basemap.url must be a relative path/)
    expect(errors).not.toMatch(/Toxicity/)
  })

  it('rejects non-objects', () => {
    expect(validateWorlds(null).errors).toEqual(['expected a JSON object'])
    expect(validateWorlds({ format: 'pcmap-worlds/1', worlds: [] }).errors).toEqual(['worlds must be a non-empty array'])
  })
})
