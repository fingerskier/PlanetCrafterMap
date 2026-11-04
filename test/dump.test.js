import { describe, expect, it } from 'vitest'
import {
  DumpParseError, MAX_LISTED, dedupKey, mergeDumps, parseDumpText, toWorldData, validateDump,
} from '../src/lib/dump.js'

// All data below is synthetic: fake ids and round-number positions.
const dumpJson = (objects, extra = {}) =>
  JSON.stringify({ format: 'pcmap-dump/1', planet: 'Prime', gameVersion: '0.0-test', randomizeMineables: false,
    source: 'test', objects, ...extra })
const ok = (raw, opts) => {
  const r = validateDump(raw, opts)
  expect(r.errors).toEqual([])
  return /** @type {import('../src/lib/dump.js').NormalizedDump} */ (r.dump)
}
const nd = (objects, extra = {}) => ({ planet: 'Prime', gameVersion: null, randomizeMineables: null, source: null,
  objects, ...extra })
const obj = (id, gId, x, y, z) => ({ id, gId, x, y, z })

describe('parseDumpText', () => {
  it('parses JSON, ignoring a BOM', () => {
    const raw = parseDumpText('﻿' + dumpJson([{ id: 100000001, gId: 'Iron', pos: [1, 2, 3] }]), 'a.json')
    expect(raw).toMatchObject({ planet: 'Prime', objects: [{ gId: 'Iron' }] })
  })

  it('sniffs JSON vs CSV from content when there is no usable extension', () => {
    expect(parseDumpText('  {"planet":"Prime","objects":[]}')).toEqual({ planet: 'Prime', objects: [] })
    expect(parseDumpText('gId,x,y,z\nIron,1,2,3\n', 'dump.txt')).toMatchObject({ objects: [{ gId: 'Iron' }] })
  })

  it('throws a DumpParseError naming the file for bad JSON or empty text', () => {
    expect(() => parseDumpText('{"planet": ', 'x/bad.json')).toThrow(DumpParseError)
    expect(() => parseDumpText('{"planet": ', 'x/bad.json')).toThrow(/^x\/bad\.json: invalid JSON/)
    expect(() => parseDumpText('  \n', 'e.csv')).toThrow(/e\.csv: file is empty/)
    expect(() => parseDumpText(null)).toThrow(/expected text/)
  })

  describe('CSV', () => {
    it('reads any column order, extra columns, mixed-case headers, CRLF and blank lines', () => {
      const text = 'note,Z,planet,GID,x,ID,y\r\n' +
        'first,30,Prime,Iron,10,100000001,20\r\n' +
        '\r\n' +
        ',-3.5,,Cobalt,-1.25,,0\r\n'
      expect(parseDumpText(text, 'a.csv')).toEqual({
        format: 'pcmap-dump/1', planet: 'Prime', gameVersion: null, randomizeMineables: null, source: null,
        objects: [
          { id: 100000001, gId: 'Iron', pos: [10, 20, 30], line: 2 },
          { id: null, gId: 'Cobalt', pos: [-1.25, 0, -3.5], line: 4 },
        ],
      })
    })

    it('handles quoted fields with commas, escaped quotes and line breaks', () => {
      const text = 'gId,x,y,z,comment\n"Iron"," 1.5 ",2,3,"a, b and ""c""\nsecond line"\nCobalt,4,5,6,plain\n'
      const raw = parseDumpText(text, 'q.csv')
      expect(raw.objects).toEqual([
        { id: null, gId: 'Iron', pos: [1.5, 2, 3], line: 2 },
        { id: null, gId: 'Cobalt', pos: [4, 5, 6], line: 4 },
      ])
      expect(raw.planet).toBeUndefined()
    })

    it('leaves malformed rows for the validator, with line numbers', () => {
      const raw = parseDumpText('gId,x,y,z,id\nIron,1,abc,3,1\nIron,0x10,2,3,\nIron,,2,3,\nIron,1,2,3,seven\n', 'm.csv')
      const { dump, errors } = validateDump(raw, { defaultPlanet: 'Prime' })
      expect(dump).toBeNull()
      expect(errors).toEqual([
        'objects[0] (line 2): pos must be [x, y, z] finite numbers or an "x,y,z" string (got "1,abc,3")',
        'objects[1] (line 3): pos must be [x, y, z] finite numbers or an "x,y,z" string (got "0x10,2,3")',
        'objects[2] (line 4): pos must be [x, y, z] finite numbers or an "x,y,z" string (got ",2,3")',
        'objects[3] (line 5): id must be a non-negative integer or null (got "seven")',
        '4 of 4 object(s) are invalid',
      ])
    })

    it.each([
      ['missing required columns', 'gId,x,z\nIron,1,2\n', /must contain gId,x,y,z \(missing: y; found: gId, x, z\)/],
      ['a duplicate column', 'gId,x,y,z,X\nIron,1,2,3,4\n', /column 'x' 2 times/],
      ['an unterminated quote', 'gId,x,y,z\n"Iron,1,2,3\n', /unterminated quoted field \(opened on line 2\)/],
      ['several planets', 'gId,x,y,z,planet\nIron,1,2,3,Prime\nIron,1,2,3,Humble\n', /2 planets \(Prime, Humble\)/],
    ])('throws on %s', (_, text, re) => {
      expect(() => parseDumpText(text, 'bad.csv')).toThrow(re)
    })
  })
})

describe('validateDump', () => {
  it('normalizes a pcmap-dump/1 object (pos array or string, id null or 0 = unknown)', () => {
    const raw = JSON.parse(dumpJson([
      { id: 100000001, gId: 'Iron', pos: [1.5, 2, -3] },
      { gId: 'Cobalt', pos: ' 4, 5.25 ,-6e1' },
      { id: 0, gId: 'ice', pos: '7,8,9' },
    ]))
    const r = validateDump(raw)
    expect(r).toEqual({
      dump: {
        planet: 'Prime', gameVersion: '0.0-test', randomizeMineables: false, source: 'test',
        objects: [obj(100000001, 'Iron', 1.5, 2, -3), obj(null, 'Cobalt', 4, 5.25, -60), obj(null, 'ice', 7, 8, 9)],
      },
      errors: [],
      warnings: [],
    })
  })

  it('takes the planet from opts.defaultPlanet only when the dump names none', () => {
    expect(ok({ format: 'pcmap-dump/1', objects: [] }, { defaultPlanet: 'Humble' }).planet).toBe('Humble')
    expect(ok({ format: 'pcmap-dump/1', planet: 'Prime', objects: [] }, { defaultPlanet: 'Humble' }).planet).toBe('Prime')
    expect(validateDump({ format: 'pcmap-dump/1', objects: [] }).errors).toEqual([
      '"planet" must be a world id such as "Prime" (got nothing)',
    ])
  })

  it('rejects non-objects, foreign formats and missing objects', () => {
    expect(validateDump([1, 2]).errors[0]).toMatch(/must be a JSON object/)
    expect(validateDump('x').dump).toBeNull()
    expect(validateDump({ format: 'pcmap-world/1', planet: 'Prime', objects: [] }).errors).toEqual([
      'unsupported format "pcmap-world/1" (expected "pcmap-dump/1")',
    ])
    expect(validateDump({ format: 'pcmap-dump/1', planet: 'Prime' }).errors).toEqual([
      '"objects" must be an array (got nothing)',
    ])
  })

  it('warns about a missing format tag, odd metadata and empty dumps', () => {
    const r = validateDump({ planet: 'Prime', gameVersion: 2.104, randomizeMineables: 'no', source: 7, objects: [] })
    expect(r.dump).toEqual({ planet: 'Prime', gameVersion: '2.104', randomizeMineables: null, source: null, objects: [] })
    expect(r.warnings).toEqual([
      'no "format" tag; assuming pcmap-dump/1',
      '"gameVersion" should be a string; read 2.104 as "2.104"',
      'ignoring "randomizeMineables" "no": expected true, false or null',
      'ignoring "source" 7: expected a string',
      'the dump has no objects',
    ])
  })

  it('warns loudly about randomizeMineables', () => {
    const r = validateDump(JSON.parse(dumpJson([], { randomizeMineables: true })))
    expect(r.dump.randomizeMineables).toBe(true)
    expect(r.warnings.join('\n')).toMatch(/randomizeMineables is true: .*do not publish it/)
  })

  it('rejects non-finite and malformed positions, ids and gIds', () => {
    const raw = JSON.parse(`{"format":"pcmap-dump/1","planet":"Prime","objects":[
      {"gId":"Iron","pos":[1e999,0,0]},
      {"gId":"Iron","pos":"1,Infinity,2"},
      {"gId":"Iron","pos":"NaN,1,2"},
      {"gId":"Iron","pos":[1,2]},
      {"gId":"Iron","pos":[1,2,"3"]},
      {"gId":"Iron"},
      {"id":-5,"gId":"Iron","pos":[1,2,3]},
      {"id":1.5,"gId":"Iron","pos":[1,2,3]},
      {"id":"100000001","gId":"Iron","pos":[1,2,3]},
      {"id":1,"gId":"","pos":[1,2,3]},
      {"id":1,"gId":" Iron","pos":[1,2,3]},
      {"id":1,"pos":[1,2,3]},
      "Iron",
      {"id":2,"gId":"Iron","pos":[1,2,3]}
    ]}`)
    const { dump, errors } = validateDump(raw)
    expect(dump).toBeNull()
    expect(errors).toHaveLength(14)
    expect(errors[0]).toBe('objects[0]: pos must be [x, y, z] finite numbers or an "x,y,z" string (got [null,0,0])')
    expect(errors[6]).toBe('objects[6]: id must be a non-negative integer or null (got -5)')
    expect(errors[11]).toBe('objects[11]: gId must be a non-empty string without surrounding spaces (got nothing)')
    expect(errors[12]).toBe('objects[12]: must be an object (got "Iron")')
    expect(errors.at(-1)).toBe('13 of 14 object(s) are invalid')
  })

  it('lists at most MAX_LISTED object errors, then the total', () => {
    const objects = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, gId: 'Iron', pos: i % 2 ? [1, 2, 3] : 'bad' }))
    const { errors } = validateDump({ format: 'pcmap-dump/1', planet: 'Prime', objects })
    expect(errors).toHaveLength(MAX_LISTED + 1)
    expect(errors.at(-1)).toBe(`25 of 50 object(s) are invalid (only the first ${MAX_LISTED} are listed)`)
  })

  it('drops objects parked at the in-space position -500,-500,-500', () => {
    const r = validateDump(JSON.parse(dumpJson([{ id: 1, gId: 'Iron', pos: [-500, -500, -500] }, { id: 2, gId: 'Iron', pos: [1, 2, 3] }])))
    expect(r.dump.objects).toEqual([obj(2, 'Iron', 1, 2, 3)])
    expect(r.warnings).toEqual(['dropped 1 object(s) at the in-space position -500,-500,-500'])
  })
})

describe('dedupKey', () => {
  it('uses the id when known, else gId and the rounded position', () => {
    expect(dedupKey(obj(100000001, 'Iron', 1, 2, 3))).toBe('id:100000001')
    expect(dedupKey(obj(null, 'Iron', 1.4, -0.4, -2.6))).toBe('Iron@1:0:-3')
  })
})

describe('mergeDumps', () => {
  it('de-duplicates by id and by position key, first wins, across and within dumps', () => {
    const a = nd([obj(100000001, 'Iron', 1, 2, 3), obj(null, 'Uranim', 10, 20, 30), obj(100000001, 'Iron', 1.5, 2, 3)])
    const b = nd([obj(100000001, 'Iron', 1.2, 2, 3), obj(null, 'Uranim', 10.3, 19.8, 30.4), obj(null, 'Uranim', 11, 20, 30),
      obj(100000002, 'Cobalt', 5, 5, 5)])
    const m = mergeDumps([a, b])
    expect(m.planet).toBe('Prime')
    expect(m.objects).toEqual([obj(100000001, 'Iron', 1, 2, 3), obj(null, 'Uranim', 10, 20, 30),
      obj(null, 'Uranim', 11, 20, 30), obj(100000002, 'Cobalt', 5, 5, 5)])
    expect(m.stats).toEqual({ input: 7, unique: 4, duplicates: 3, conflicts: 0 })
    expect(m.warnings).toEqual([])
    expect(m.objects[0]).not.toBe(a.objects[0])
  })

  it('counts and reports conflicts: same key with another gId, or more than 1 unit apart', () => {
    const a = nd([obj(100000001, 'Iron', 1, 2, 3), obj(100000002, 'Cobalt', 0, 0, 0)])
    const b = nd([obj(100000001, 'Titanium', 1, 2, 3), obj(100000002, 'Cobalt', 0, 0, 1.01), obj(100000002, 'Cobalt', 0, 0, 1)])
    const m = mergeDumps([a, b], { names: ['a.json', 'b.csv'] })
    expect(m.stats).toEqual({ input: 5, unique: 2, duplicates: 3, conflicts: 2 })
    expect(m.objects.map((o) => o.gId)).toEqual(['Iron', 'Cobalt'])
    expect(m.warnings).toEqual([
      'conflict on id:100000001: kept Iron at 1,2,3 from a.json, dropped Titanium at 1,2,3 from b.csv (0.00 units apart)',
      'conflict on id:100000002: kept Cobalt at 0,0,0 from a.json, dropped Cobalt at 0,0,1.01 from b.csv (1.01 units apart)',
    ])
  })

  it('caps listed conflicts', () => {
    const n = MAX_LISTED + 5
    const a = nd(Array.from({ length: n }, (_, i) => obj(i + 1, 'Iron', 0, 0, 0)))
    const b = nd(Array.from({ length: n }, (_, i) => obj(i + 1, 'Cobalt', 0, 0, 0)))
    const m = mergeDumps([a, b])
    expect(m.stats.conflicts).toBe(n)
    expect(m.warnings).toHaveLength(MAX_LISTED + 1)
    expect(m.warnings.at(-1)).toBe(`${n} conflicts in total (only the first ${MAX_LISTED} are listed)`)
  })

  it('aggregates metadata', () => {
    const m = mergeDumps([
      nd([], { gameVersion: '2.104', randomizeMineables: false, source: 'tool b' }),
      nd([], { gameVersion: null, randomizeMineables: null, source: 'tool a' }),
      nd([], { gameVersion: '2.104', randomizeMineables: true, source: 'tool b' }),
    ])
    expect(m.gameVersions).toEqual(['2.104'])
    expect(m.randomizeMineables).toBe(true)
    expect(m.sources).toEqual(['tool a', 'tool b'])
    expect(mergeDumps([nd([], { randomizeMineables: false }), nd([])]).randomizeMineables).toBe(false)
    expect(mergeDumps([nd([])]).randomizeMineables).toBeNull()
    const two = mergeDumps([nd([], { gameVersion: '2.103' }), nd([], { gameVersion: '2.104' })])
    expect(two.gameVersions).toEqual(['2.103', '2.104'])
    expect(two.warnings).toEqual(['dumps come from 2 game versions (2.103, 2.104); gameVersion is left unset'])
  })

  it('requires one planet', () => {
    expect(() => mergeDumps([nd([]), nd([], { planet: 'Humble' })])).toThrow(/same planet; expected 'Prime', also got 'Humble'/)
    expect(() => mergeDumps([nd([])], { planet: 'Skeo' })).toThrow(/expected 'Skeo', also got 'Prime'/)
    expect(() => mergeDumps([])).toThrow(/pass opts.planet/)
    expect(mergeDumps([], { planet: 'Skeo' })).toMatchObject({
      planet: 'Skeo', objects: [], stats: { input: 0, unique: 0, duplicates: 0, conflicts: 0 },
    })
  })
})

describe('toWorldData', () => {
  const merged = (objects, extra = {}) => ({ ...mergeDumps([nd(objects)]), ...extra })

  it('writes sorted gids and points [gidIndex, x, y, z, id], rounded to 0.1', () => {
    const w = toWorldData(merged([
      obj(100000003, 'Iron', 5, 0, 1),
      obj(null, 'Iron', 5, 0, -1),
      obj(100000001, 'Cobalt', 1.26, 2.24, -0.04),
      obj(100000002, 'Iron', -3, 9, 9),
      obj(100000005, 'Iron', 5, -1, 1),
      obj(100000004, 'Iron', 5, -1, 1.04),
    ], { gameVersions: ['2.104'], sources: ['t'] }))
    expect(w).toEqual({
      format: 'pcmap-world/1', world: 'Prime', gameVersion: '2.104', randomizeMineables: null, sources: ['t'],
      gids: ['Cobalt', 'Iron'],
      points: [
        [0, 1.3, 2.2, 0, 100000001],
        [1, -3, 9, 9, 100000002],
        [1, 5, 0, -1, 0],
        [1, 5, -1, 1, 100000004],
        [1, 5, -1, 1, 100000005],
        [1, 5, 0, 1, 100000003],
      ],
    })
    expect(Object.is(w.points[0][3], -0)).toBe(false)
    expect(w).not.toHaveProperty('rev')
  })

  it('sorts gIds by code unit, not locale', () => {
    expect(toWorldData(merged([obj(1, 'ice', 0, 0, 0), obj(2, 'Iron', 0, 0, 0), obj(3, 'Zeolite', 0, 0, 0)])).gids)
      .toEqual(['Iron', 'Zeolite', 'ice'])
  })

  it('excludes runtime ids (>= 200000000) unless includeRuntime', () => {
    const m = merged([obj(199999999, 'Iron', 0, 0, 0), obj(200000000, 'Container1', 1, 1, 1), obj(null, 'Cobalt', 2, 2, 2)])
    expect(toWorldData(m).points.map((p) => p[4])).toEqual([0, 199999999])
    expect(toWorldData(m).gids).toEqual(['Cobalt', 'Iron'])
    expect(toWorldData(m, { includeRuntime: true }).points.map((p) => p[4])).toEqual([0, 200000000, 199999999])
  })

  it('sets gameVersion only when unique, and keeps randomizeMineables', () => {
    expect(toWorldData(merged([], { gameVersions: ['2.103', '2.104'] })).gameVersion).toBeNull()
    expect(toWorldData(merged([], { randomizeMineables: true })).randomizeMineables).toBe(true)
    expect(toWorldData(mergeDumps([], { planet: 'Skeo' }))).toEqual({
      format: 'pcmap-world/1', world: 'Skeo', gameVersion: null, randomizeMineables: null, sources: [], gids: [], points: [],
    })
  })

  it('is independent of input order', () => {
    const objects = [obj(100000001, 'Iron', 1, 2, 3), obj(100000002, 'Cobalt', 3, 2, 1), obj(null, 'ice', -1, 0, 4)]
    expect(toWorldData(merged([...objects].reverse()))).toEqual(toWorldData(merged(objects)))
  })
})

describe('end to end: text -> world data', () => {
  it('merges a JSON and a CSV dump of the same objects', () => {
    const a = ok(parseDumpText(dumpJson([{ id: 100000001, gId: 'Iron', pos: [1, 2, 3] }, { gId: 'Cobalt', pos: '4,5,6' }]), 'a.json'))
    const b = ok(parseDumpText('id,gId,x,y,z\n100000001,Iron,1.2,2,3\n,Cobalt,4.2,5,6\n,Cobalt,40,5,6\n', 'b.csv'),
      { defaultPlanet: 'Prime' })
    const m = mergeDumps([a, b])
    expect(m.stats).toEqual({ input: 5, unique: 3, duplicates: 2, conflicts: 0 })
    expect(toWorldData(m).points).toEqual([[0, 4, 5, 6, 0], [0, 40, 5, 6, 0], [1, 1, 2, 3, 100000001]])
  })
})
