import { describe, expect, it } from 'vitest'
import { planetHash } from '../src/lib/planets.js'
import { SaveFormatError, buildSaveOverlay, decodeSaveBytes, isSaveText, parseSave } from '../src/lib/save.js'
import { FAKE_PRIME, buildSaveBytes, buildSaveText, bulkSections } from './fixtures/save-builder.js'

const WORLDS = ['Prime', 'Humble', 'Selenea', 'Aqualis', 'Toxicity', 'Skeo']
const H = Object.fromEntries(WORLDS.map((w) => [w, planetHash(w)]))
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join(' ')
const overlayOf = (opts) => buildSaveOverlay(parseSave(buildSaveText(opts)), WORLDS)

describe('save-builder framing (byte-exact)', () => {
  it('Steam-style: BOM, CR, CR@CR separators, CR@ terminator, |LF records', () => {
    const b = buildSaveBytes({ bom: true, sections: { instances: [{ owner: 0, seed: 1, pos: '1,2,3' }] } })
    expect(hex(b.slice(0, 5))).toBe('ef bb bf 0d 7b')
    expect(hex(b.slice(-3))).toBe('7d 0d 40')
    const t = buildSaveText()
    expect(t.split('\r@\r')).toHaveLength(10)
    expect(t.includes('|\n')).toBe(true)
  })

  it('Game Pass-style: no BOM; empty section 9 gives the "\\r@\\r\\r@" tail', () => {
    const b = buildSaveBytes()
    expect(hex(b.slice(0, 2))).toBe('0d 7b')
    expect(buildSaveText().endsWith('}\r@\r\r@')).toBe(true)
  })
})

describe('decodeSaveBytes', () => {
  it('strips a UTF-8 BOM; BOM and no-BOM decode to the same text', () => {
    const withBom = decodeSaveBytes(buildSaveBytes({ bom: true }))
    const without = decodeSaveBytes(buildSaveBytes())
    expect(withBom.charCodeAt(0)).toBe(0x0d)
    expect(withBom).toBe(without)
    expect(parseSave(withBom).layout).toBe('current')
  })

  it('accepts ArrayBuffer, Uint8Array and offset views', () => {
    const b = buildSaveBytes({ bom: true })
    const padded = new Uint8Array(b.length + 4)
    padded.set(b, 2)
    const view = padded.subarray(2, 2 + b.length)
    const expected = buildSaveText()
    expect(decodeSaveBytes(b)).toBe(expected)
    expect(decodeSaveBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))).toBe(expected)
    expect(decodeSaveBytes(view)).toBe(expected)
    expect(decodeSaveBytes(new DataView(padded.buffer, 2, b.length))).toBe(expected)
  })

  it('decodes non-ASCII UTF-8 text', () => {
    const t = buildSaveText({ sections: { players: [{ name: 'Pilöt ✓ 名前', playerPosition: '1,2,3', planetId: 'Prime' }] } })
    expect(parseSave(decodeSaveBytes(new TextEncoder().encode(t))).players[0].name).toBe('Pilöt ✓ 名前')
  })

  it.each([
    ['UTF-16 LE', [0xff, 0xfe, 0x0d, 0x00, 0x7b, 0x00], /UTF-16 LE.*FF FE/],
    ['UTF-16 BE', [0xfe, 0xff, 0x00, 0x0d, 0x00, 0x7b], /UTF-16 BE.*FE FF/],
    ['UTF-32 LE', [0xff, 0xfe, 0x00, 0x00, 0x0d, 0x00, 0x00, 0x00], /UTF-32 LE/],
    ['BOM-less UTF-16 LE', [0x0d, 0x00, 0x7b, 0x00, 0x22, 0x00], /NUL bytes/],
  ])('rejects %s with a SaveFormatError naming it', (_, bytes, msg) => {
    const run = () => decodeSaveBytes(new Uint8Array(bytes))
    expect(run).toThrow(SaveFormatError)
    expect(run).toThrow(msg)
  })

  it('rejects invalid UTF-8', () => {
    const good = buildSaveBytes()
    const bad = new Uint8Array([...good.slice(0, 10), 0xc3, 0x28, ...good.slice(10)])
    expect(() => decodeSaveBytes(bad)).toThrow(SaveFormatError)
    expect(() => decodeSaveBytes(bad)).toThrow(/not valid UTF-8/)
    expect(() => decodeSaveBytes(new Uint8Array([0x0d, 0x7b, 0xff, 0x7d]))).toThrow(SaveFormatError)
  })

  it('rejects non-binary input with a TypeError', () => {
    expect(() => decodeSaveBytes('text')).toThrow(TypeError)
  })
})

describe('isSaveText', () => {
  it.each([
    ['current, native', buildSaveText()],
    ['current, with BOM', buildSaveText({ bom: true })],
    ['CRLF', buildSaveText({ eol: 'crlf' })],
    ['LF only', buildSaveText({ eol: 'lf' })],
    ['legacy 11', buildSaveText({ layout: 11 })],
    ['legacy 2022', buildSaveText({ layout: 9 })],
    ['bare @ between records', '{"unitOxygenLevel":1.5,"terraTokens":0}@{"playerPosition":"1,2,3"}@@'],
    ['"@" inside section 0 text', buildSaveText({ sections: { worldState: [{ terraTokens: 1, note: '}@{' }] } })],
  ])('true for %s', (_, text) => expect(isSaveText(text)).toBe(true))

  const dump = { format: 'pcmap-dump/1', planet: 'Prime', source: 'fake@tool | v1\r\n@\r\n',
    objects: [{ id: 101000001, gId: 'FakeOre', pos: [1, 2, 3] }] }
  it.each([
    ['pcmap-dump JSON (compact)', JSON.stringify(dump)],
    ['pcmap-dump JSON (pretty)', JSON.stringify(dump, null, 2)],
    ['pcmap-dump JSON with BOM', '﻿' + JSON.stringify(dump)],
    ['CSV', 'id,gId,x,y,z\n101000001,FakeOre,1,2,3\n@\n'],
    ['random JSON object', '{"hello":"world","n":[1,2,{"a":"@"}]}'],
    ['JSON with "}@" inside a string', '{"a":"x}@y","b":"\\"}@"}'],
    ['JSON array', '[{"gId":"FakeOre"}]'],
    ['plain text with @', 'mail me @ example\r@\r'],
    ['empty', ''],
    ['whitespace', ' \r\n '],
    ['not a string', null],
  ])('false for %s', (_, text) => expect(isSaveText(text)).toBe(false))
})

describe('parseSave: framing', () => {
  it('reads a current 10-section save', () => {
    const p = parseSave(buildSaveText({
      sections: { worldObjects: [{ id: 205000001, gId: 'FakeBench', pos: '1,2,3', planet: FAKE_PRIME }] },
    }))
    expect(p.layout).toBe('current')
    expect(p.sectionCount).toBe(10)
    expect(p.sectionKinds).toEqual(['worldState', 'terraformation', 'players', 'worldObjects', 'inventories',
      'stats', 'messages', 'storyEvents', 'meta', 'instances'])
    expect(p.startPlanet).toBe('Prime')
    expect(p.version).toBe('9.999')
    expect(p.randomizeMineables).toBe(false)
    expect(p.meta.saveDisplayName).toBe('Synthetic Test Save')
    expect(p.worldObjects).toHaveLength(1)
    expect(p.inventories).toHaveLength(2)
    expect(p.players).toHaveLength(1)
    expect(p.terraformation[0].planetId).toBe('Prime')
    expect(p.warnings).toEqual([])
  })

  it('empty section 9 (tail "\\r@\\r\\r@") is kept by position', () => {
    const t = buildSaveText({ sections: { instances: [] } })
    expect(t.endsWith('\r@\r\r@')).toBe(true)
    const p = parseSave(t)
    expect(p.sectionCount).toBe(10)
    expect(p.layout).toBe('current')
    expect(p.sectionKinds[9]).toBe('instances')
    expect(p.instances).toEqual([])
  })

  it('empty middle sections fall back to their position', () => {
    const p = parseSave(buildSaveText({ sections: { messages: [], storyEvents: [], inventories: [] } }))
    expect(p.layout).toBe('current')
    expect(p.sectionKinds.slice(4, 8)).toEqual(['inventories', 'stats', 'messages', 'storyEvents'])
    expect(p.warnings).toEqual([])
  })

  it('"@" and "|" inside JSON strings (incl. escaped quotes and backslashes) do not split', () => {
    const tricky = 'Ore@Base | stash "quoted" \\ back\\slash\\\\" @ |\n@\r'
    const wo = { id: 205000002, gId: 'FakeSign', text: tricky, pos: '5,6,7', planet: FAKE_PRIME }
    const p = parseSave(buildSaveText({
      sections: {
        worldObjects: [wo, { id: 205000003, gId: 'FakeBench' }],
        players: [{ id: 0, name: 'a@b|c', playerPosition: '1,2,3', planetId: 'Prime' }],
      },
    }))
    expect(p.layout).toBe('current')
    expect(p.worldObjects).toHaveLength(2)
    expect(p.worldObjects[0].text).toBe(tricky)
    expect(p.players[0].name).toBe('a@b|c')
    expect(p.warnings).toEqual([])
  })

  it.each(['crlf', 'lf'])('%s line endings parse like native', (eol) => {
    const sections = {
      worldObjects: [{ id: 205000004, gId: 'FakeBench', pos: '1,2,3', planet: FAKE_PRIME }, { id: 101000005, gId: 'FakeOre' }],
      instances: [],
    }
    const native = parseSave(buildSaveText({ sections }))
    const other = parseSave(buildSaveText({ sections, eol, bom: true }))
    expect(other).toEqual(native)
  })

  it('tolerates trailing whitespace and a missing terminator', () => {
    const sections = { instances: [{ owner: 0, seed: 9, index: 1, pos: '1,2,3', planet: FAKE_PRIME }] }
    const base = parseSave(buildSaveText({ sections }))
    expect(parseSave(buildSaveText({ sections, trailer: ' \r\n\t' }))).toEqual(base)
    expect(parseSave(buildSaveText({ sections, terminator: false }))).toEqual(base)
    expect(parseSave(buildSaveText({ sections, terminator: false, trailer: '\n' }))).toEqual(base)
  })

  it('keeps unknown extra keys and tolerates mod-added sections by content', () => {
    const p = parseSave(buildSaveText({
      sections: {
        worldState: [{ terraTokens: 1, pcdsCurrentPlanet: 'Humble' }],
        worldObjects: [{ id: 205000006, gId: 'FakeBench', futureKey: { nested: [1, '@|'] }, pos: '1,2,3' }],
      },
    }))
    expect(p.layout).toBe('current')
    expect(p.worldObjects[0].futureKey).toEqual({ nested: [1, '@|'] })
  })

  it('an unparsable record becomes a warning and is skipped', () => {
    const p = parseSave(buildSaveText({
      sections: { worldObjects: ['{"id":205000007,"gId":"FakeBench"', '[1,2]', '{"id":205000008,"gId":"FakeBench"}'] },
    }))
    expect(p.worldObjects.map((w) => w.id)).toEqual([205000008])
    expect(p.warnings).toHaveLength(2)
    expect(p.warnings[0]).toMatch(/Section 3, record 0: not valid JSON/)
    expect(p.warnings[1]).toMatch(/Section 3, record 1: not a JSON object/)
  })

  it('caps per-record warnings', () => {
    const p = parseSave(buildSaveText({ sections: { worldObjects: Array(50).fill('{bad}') } }))
    expect(p.warnings).toHaveLength(21)
    expect(p.warnings[20]).toMatch(/30 more/)
  })

  it.each([
    ['empty text', ''],
    ['BOM only', '﻿\r\n'],
    ['no separators', '{"id":1,"gId":"FakeOre"}'],
    ['a pcmap-dump JSON', JSON.stringify({ format: 'pcmap-dump/1', planet: 'Prime', objects: [] })],
    ['unterminated string', '\r{"terraTokens":1}\r@\r{"name":"open\r@\r{"gId":"x"}\r@'],
    ['sections without save data', '\r{"a":1}\r@\r{"b":2}\r@'],
  ])('throws SaveFormatError for %s', (_, text) => {
    expect(() => parseSave(text)).toThrow(SaveFormatError)
  })

  it.each([
    ['an "@" flood', '{"terraTokens":1}\r@' + '@'.repeat(100_000)],
    ['65 sections', '{"terraTokens":1}' + '@'.repeat(65)],
    ['64 "@" plus a non-empty tail', '{"terraTokens":1}' + '@'.repeat(64) + '{"gId":"x","id":1}'],
    ['many world-object sections', '{"terraTokens":1}\r@' + '{"gId":"x","id":1}@'.repeat(1000)],
  ])('throws SaveFormatError for more than 64 sections: %s', (_, text) => {
    expect(() => parseSave(text)).toThrow(SaveFormatError)
    expect(() => parseSave(text)).toThrow(/more than 64 sections/)
  })

  it('accepts exactly 64 sections', () => {
    const p = parseSave('{"terraTokens":1}' + '@'.repeat(64))
    expect(p.sectionCount).toBe(64)
    expect(p.layout).toBe('unknown')
  })

  it('throws TypeError for non-string input', () => {
    expect(() => parseSave(new Uint8Array(3))).toThrow(TypeError)
  })
})

describe('parseSave: layouts', () => {
  it('11 sections with a layerId section at 9: instances come from section 10', () => {
    const inst = { owner: 0, planet: FAKE_PRIME, index: 2, seed: 777, pos: '100,5,200', woIdsGenerated: '205000010' }
    const p = parseSave(buildSaveText({ layout: 11, sections: { instances: [inst] } }))
    expect(p.layout).toBe('legacy-terrain-layers')
    expect(p.sectionCount).toBe(11)
    expect(p.sectionKinds[9]).toBe('layers')
    expect(p.sectionKinds[10]).toBe('instances')
    expect(p.instances).toEqual([inst])
  })

  it('11 sections with both tail sections empty', () => {
    const p = parseSave(buildSaveText({ layout: 11, sections: { layers: [], instances: [] } }))
    expect(p.layout).toBe('legacy-terrain-layers')
    expect(p.sectionKinds.slice(8)).toEqual(['meta', 'layers', 'instances'])
  })

  it('9-section 2022 save: explicit defaults ("pos":"0,0,0", "wear") and no planet key', () => {
    const t = buildSaveText({
      layout: 9,
      sections: {
        worldObjects: [
          '{"id":107000001,"gId":"FakeIce","liId":0,"pos":"0,0,0","wear":0}',
          '{"id":107000002,"gId":"FakeOre","liId":0,"pos":"0,0,0","wear":0}',
          '{"id":207000003,"gId":"FakeBench","liId":0,"pos":"12.5,3,-40","rot":"0,0,0,1","wear":0}',
          '{"id":207000004,"gId":"FakeCrate","liId":5,"pos":"0,0,0","wear":0}',
        ],
        inventories: [{ id: 5, woIds: '107000002', size: 10 }],
      },
    })
    const p = parseSave(t)
    expect(p.layout).toBe('legacy-2022')
    expect(p.sectionCount).toBe(9)
    expect(p.sectionKinds[0]).toBe('terraformation')
    expect(p.sectionKinds[7]).toBe('meta')
    expect(p.sectionKinds[8]).toBe('layers')
    expect(p.meta).toEqual({ mode: 'Standard' })
    expect(p.startPlanet).toBe('Prime')
    expect(p.version).toBe(null)
    expect(p.players[0].unlockedGroups).toBe('FakeUnlockA,FakeUnlockB')
    expect(p.instances).toEqual([])

    const o = buildSaveOverlay(p, WORLDS)
    expect(o.worlds.Prime.objects).toEqual([{ id: 207000003, gId: 'FakeBench', x: 12.5, y: 3, z: -40, origin: 'built' }])
    expect(o.worlds.Prime.players).toEqual([{ name: '', x: 11, y: 22, z: 33 }])
    // Default-valued fields count as absent; 107000002 was picked up and is held in an inventory.
    expect(o.collectedSceneIds).toEqual([107000001, 107000002])
  })

  it('in-between layout (unit levels + terraTokens in section 0) is read by content', () => {
    const p = parseSave('{"unitOxygenLevel":1.2,"terraTokens":0,"unlockedGroups":"FakeUnlockA"}@' +
      '{"playerPosition":"1,2,3","name":"Tester"}@@')
    expect(p.layout).toBe('unknown')
    expect(p.sectionKinds).toEqual(['terraformation', 'players', 'unknown'])
    expect(p.players[0].name).toBe('Tester')
    expect(p.warnings[0]).toMatch(/Unexpected section count 3/)
  })

  it('unexpected section count (12): reads by content, layout unknown', () => {
    const order = ['worldState', 'terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages',
      'storyEvents', 'meta', 'layers', 'instances', 'modExtra']
    const p = parseSave(buildSaveText({
      layout: 11,
      order,
      sections: { instances: [{ owner: 0, seed: 1, pos: '1,2,3' }], modExtra: [{ fakeModState: 1 }] },
    }))
    expect(p.layout).toBe('unknown')
    expect(p.sectionCount).toBe(12)
    expect(p.sectionKinds.slice(9)).toEqual(['layers', 'instances', 'unknown'])
    expect(p.instances).toHaveLength(1)
    expect(p.meta.saveDisplayName).toBe('Synthetic Test Save')
    expect(p.warnings[0]).toMatch(/Unexpected section count 12/)
  })

  it('11 sections whose tail is not layers + instances -> unknown, read by content', () => {
    const order = ['worldState', 'terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages',
      'storyEvents', 'meta', 'instances', 'modExtra']
    const p = parseSave(buildSaveText({
      order,
      sections: {
        worldObjects: [{ id: 205000011, gId: 'FakeBench', pos: '1,2,3' }],
        instances: [{ owner: 0, seed: 1, pos: '1,2,3' }],
        modExtra: [{ fakeModState: 1 }],
      },
    }))
    expect(p.layout).toBe('unknown')
    expect(p.sectionKinds[10]).toBe('unknown')
    expect(p.worldObjects).toHaveLength(1)
    expect(p.instances).toHaveLength(1)
    expect(p.warnings[0]).toMatch(/section 9 holds instances data, where a 11-section save has layers/i)
  })

  it('10 sections whose content does not match the current layout -> unknown, read by content', () => {
    const order = ['terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages', 'storyEvents',
      'meta', 'layers', 'instances']
    const p = parseSave(buildSaveText({ order, sections: { instances: [] } }))
    expect(p.layout).toBe('unknown')
    expect(p.players).toHaveLength(1)
    expect(p.sectionKinds[9]).toBe('unknown')
  })

  it('reads startPlanet, version and randomizeMineables from metadata', () => {
    const p = parseSave(buildSaveText({
      sections: { meta: [{ saveDisplayName: 'Fake', planetId: 'Humble', version: '9.1', worldSeed: 1, randomizeMineables: true }] },
    }))
    expect(p.startPlanet).toBe('Humble')
    expect(p.version).toBe('9.1')
    expect(p.randomizeMineables).toBe(true)
    const q = parseSave(buildSaveText({ sections: { meta: [{ saveDisplayName: 'Fake', planetId: '', worldSeed: 1 }] } }))
    expect(q.startPlanet).toBe('Prime')
    expect(q.version).toBe(null)
    expect(q.randomizeMineables).toBe(false)
  })

  it.each([
    ['an object with a non-callable toString', '{"toString":0}', null],
    ['a plain object', '{"a":1}', null],
    ['an array', '["9.1"]', null],
    ['a boolean', 'true', null],
    ['a number', '2.1', '2.1'],
  ])('meta.version that is %s', (_, raw, expected) => {
    const p = parseSave(buildSaveText({ sections: { meta: [`{"saveDisplayName":"Fake","worldSeed":1,"version":${raw}}`] } }))
    expect(p.version).toBe(expected)
  })
})

describe('buildSaveOverlay', () => {
  it('parses exponent and integer vector components', () => {
    const o = overlayOf({
      sections: {
        worldObjects: [
          `{"id":205000020,"gId":"FakeBench","pos":"1016,161,4448","planet":${H.Prime}}`,
          `{"id":205000021,"gId":"FakeBench","pos":"-2.911978E-10,1E+03,-0.5","planet":${H.Prime}}`,
          `{"id":205000022,"gId":"FakeBench","pos":"1,2","planet":${H.Prime}}`,
          `{"id":205000023,"gId":"FakeBench","pos":"1,,2","planet":${H.Prime}}`,
          `{"id":205000024,"gId":"FakeBench","pos":"1,NaN,2","planet":${H.Prime}}`,
        ],
        players: [{ id: 0, name: 'P', playerPosition: '1213.663,1.55E+02,-4.371139E-08', planetId: 'Prime' }],
      },
    })
    expect(o.worlds.Prime.objects.map(({ x, y, z }) => [x, y, z])).toEqual([[1016, 161, 4448], [-2.911978e-10, 1000, -0.5]])
    expect(o.worlds.Prime.players).toEqual([{ name: 'P', x: 1213.663, y: 155, z: -4.371139e-8 }])
  })

  it('filters (0,0,0) and the (-500,-500,-500) sentinel', () => {
    const o = overlayOf({
      sections: {
        worldObjects: [
          { id: 205000030, gId: 'SpaceMultiplierOxygen', pos: '-500,-500,-500', planet: H.Prime },
          { id: 205000031, gId: 'FakeRocket', pos: '-500.0,-500,-5E+02', planet: H.Prime },
          { id: 205000032, gId: 'FakeBench', pos: '0,0,0', planet: H.Prime },
          { id: 205000033, gId: 'FakeBench', pos: '-0,0,0.0', planet: H.Prime },
          { id: 205000034, gId: 'FakeBench', pos: '-500,-500,-499', planet: H.Prime },
        ],
      },
    })
    expect(o.worlds.Prime.objects.map((x) => x.id)).toEqual([205000034])
    expect(o.counts.sentinel).toBe(2)
    expect(o.counts.placed).toBe(1)
  })

  it('maps planet hashes to worlds; missing or 0 planet -> startPlanet', () => {
    const o = overlayOf({
      sections: {
        meta: [{ saveDisplayName: 'Fake', planetId: 'Humble', worldSeed: 1 }],
        worldObjects: [
          { id: 205000040, gId: 'FakeBench', pos: '1,2,3', planet: H.Aqualis },
          { id: 205000041, gId: 'FakeBench', pos: '1,2,3' },
          { id: 205000042, gId: 'FakeBench', pos: '1,2,3', planet: 0 },
          { id: 205000043, gId: 'FakeBench', pos: '1,2,3', planet: H.Toxicity },
          { id: 205000044, gId: 'FakeBench', pos: '1,2,3', planet: H.Skeo },
        ],
      },
    })
    expect(o.startPlanet).toBe('Humble')
    expect(Object.keys(o.worlds)).toEqual(WORLDS)
    expect(o.worlds.Aqualis.objects.map((x) => x.id)).toEqual([205000040])
    expect(o.worlds.Humble.objects.map((x) => x.id)).toEqual([205000041, 205000042])
    expect(o.worlds.Toxicity.objects.map((x) => x.id)).toEqual([205000043])
    expect(o.worlds.Skeo.objects.map((x) => x.id)).toEqual([205000044])
    expect(o.worlds.Prime.objects).toEqual([])
    expect(o.unknownPlanetHashes).toEqual([])
  })

  it('unknown planet hashes are reported (deduped, sorted) and their objects skipped', () => {
    const fake = planetHash('FakePlanetX')
    const o = buildSaveOverlay(parseSave(buildSaveText({
      sections: {
        worldObjects: [
          { id: 205000050, gId: 'FakeBench', pos: '1,2,3', planet: fake },
          { id: 205000051, gId: 'FakeBench', pos: '1,2,3', planet: fake },
          { id: 205000052, gId: 'FakeBench', pos: '1,2,3', planet: 12345 },
          { id: 205000053, gId: 'FakeBench', pos: '1,2,3', planet: H.Selenea },
          { id: 205000054, gId: 'FakeBench', planet: 999 },
        ],
      },
    })), ['Prime', 'Humble'])
    expect(o.unknownPlanetHashes).toEqual([fake, 12345, H.Selenea].sort((a, b) => a - b))
    expect(o.worlds.Prime.objects).toEqual([])
    expect(o.counts.unknownPlanet).toBe(4)
    expect(o.warnings.at(-1)).toMatch(/4 item\(s\) on unrecognised planet/)
    expect(o.worlds.Selenea).toBeUndefined()
  })

  it.each(['__proto__', 'constructor', 'toString'])('meta.planetId %s is no world: worlds[startPlanet] misses', (planetId) => {
    const o = overlayOf({
      sections: {
        meta: [{ saveDisplayName: 'Fake', planetId, worldSeed: 1 }],
        players: [{ id: 0, name: 'P', playerPosition: '1,2,3', planetId: '' }],
        worldObjects: [{ id: 205000056, gId: 'FakeBench', pos: '1,2,3' }],
      },
    })
    expect(o.startPlanet).toBe(planetId)
    expect(o.worlds[planetId]).toBeUndefined()
    expect(Object.keys(o.worlds)).toEqual(WORLDS)
    expect(o.counts.objects + o.counts.players).toBe(0)
    expect(o.counts.unknownPlanet).toBe(2)
    expect(o.unknownPlanetHashes).toEqual([planetHash(planetId)])
  })

  it('startPlanet missing from worldIds: planet-less objects become unknown', () => {
    const o = buildSaveOverlay(parseSave(buildSaveText({
      sections: { worldObjects: [{ id: 205000055, gId: 'FakeBench', pos: '1,2,3' }] },
    })), ['Humble'])
    expect(o.unknownPlanetHashes).toEqual([H.Prime])
  })

  it('players: planetId selects the world, empty -> startPlanet, Steam ids are not keys', () => {
    // Two Steam ids that collapse to the same double; both players must survive.
    const t = buildSaveText({
      sections: {
        meta: [{ saveDisplayName: 'Fake', planetId: 'Selenea', worldSeed: 1 }],
        players: [
          '{"id":76561190000000001,"name":"Host","playerPosition":"1,2,3","planetId":"Aqualis","host":true}',
          '{"id":76561190000000002,"name":"Guest","playerPosition":"4,5,6","planetId":""}',
          '{"id":76561190000000003,"name":"Lost","playerPosition":"7,8,9","planetId":"FakePlanetY"}',
          '{"id":5,"name":"NoPos","planetId":"Prime"}',
        ],
      },
    })
    const o = buildSaveOverlay(parseSave(t), WORLDS)
    expect(o.worlds.Aqualis.players).toEqual([{ name: 'Host', x: 1, y: 2, z: 3 }])
    expect(o.worlds.Selenea.players).toEqual([{ name: 'Guest', x: 4, y: 5, z: 6 }])
    expect(o.unknownPlanetHashes).toEqual([planetHash('FakePlanetY')])
    expect(o.counts.players).toBe(2)
    expect(o.warnings).toContain('1 player(s) without a readable position skipped.')
  })

  it('classifies origin', () => {
    const wo = (id, gId) => ({ id, gId, pos: '1,2,3', planet: H.Prime })
    const o = overlayOf({
      sections: {
        worldObjects: [
          wo(205000060, 'ProceduralWreckContainer1'),
          wo(105000061, 'WreckEntryLockedFake'),
          wo(205000062, 'WreckFusionGeneratorFake'),
          wo(205000063, 'FakeShelf'), // in woIdsGenerated
          wo(205000064, 'Fridge1'), // in woIdsGenerated
          wo(205000065, 'FakeFoundation'),
          wo(205000066, 'Counter1'),
          wo(205000067, 'Vault1'),
          wo(105000068, 'FakeCrate'),
          wo(50_000_069, 'FakeModThing'),
          wo(900_000_000, 'FakeModThing'),
        ],
        instances: [
          { owner: 0, planet: H.Prime, index: 0, seed: 1, pos: '9,9,9', woIdsGenerated: '205000063,205000064', woIdsDropped: '' },
          { owner: 0, planet: H.Humble, index: 1, seed: 2, pos: '9,9,9', woIdsGenerated: '' },
        ],
      },
    })
    const origins = Object.fromEntries(o.worlds.Prime.objects.map((x) => [x.id, x.origin]))
    expect(origins).toEqual({
      205000060: 'wreck',
      105000061: 'wreck',
      205000062: 'wreck',
      205000063: 'wreck',
      205000064: 'wreck',
      205000065: 'built',
      205000066: 'unknown',
      205000067: 'unknown',
      105000068: 'scene',
      50000069: 'unknown',
      900000000: 'built',
    })
    expect(o.counts.byOrigin).toEqual({ built: 2, wreck: 5, scene: 1, unknown: 3 })
  })

  it('procedural instances: pos, planet (missing -> startPlanet), seed, index', () => {
    const o = overlayOf({
      sections: {
        instances: [
          { owner: 0, planet: H.Selenea, index: 3, seed: 181000001, pos: '-1.5E+02,20,30', rot: '0,0,0,1', version: 16 },
          { owner: 0, index: 4, seed: 5, pos: '1,2,3' },
          { owner: 0, planet: H.Prime, index: 5, seed: 6, pos: '0,0,0' },
          { owner: 0, planet: H.Prime, index: 6, seed: 7 },
        ],
      },
    })
    expect(o.worlds.Selenea.instances).toEqual([{ x: -150, y: 20, z: 30, seed: 181000001, index: 3 }])
    expect(o.worlds.Prime.instances).toEqual([{ x: 1, y: 2, z: 3, seed: 5, index: 4 }])
    expect(o.counts.instances).toBe(2)
  })

  it('collectedSceneIds: bare and not placed (held counts); lootedSceneInventoryIds: scene-range inventory ids', () => {
    const o = overlayOf({
      sections: {
        worldObjects: [
          { id: 101000070, gId: 'FakeOre' }, // collected
          { id: 101000070, gId: 'FakeOre' }, // duplicate -> deduped
          { id: 101000071, gId: 'FakeOre' }, // picked up, held in an inventory -> collected
          { id: 101000072, gId: 'FakeLift', grwth: 100 }, // has state -> ambiguous
          { id: 101000073, gId: 'FakeCrate', liId: 101000073 }, // has state -> ambiguous
          { id: 101000074, gId: 'FakeOre', pos: '1,2,3', planet: H.Prime }, // placed
          { id: 101000075, gId: 'FakeOre', pos: '-500,-500,-500', planet: H.Prime }, // sentinel, not bare
          { id: 205000076, gId: 'FakeOre' }, // runtime id
          { id: 99_000_077, gId: 'FakeOre' }, // below scene range
          { id: 101000078, gId: 'FakeOre', liId: 0, pos: '0,0,0' }, // explicit defaults = bare
          { id: 101000069, gId: 'FakeOre' }, // collected
          { id: 101000079, gId: 'FakeOre' }, // bare here, but placed in another record
          { id: 101000079, gId: 'FakeOre', pos: '4,5,6', planet: H.Prime },
        ],
        inventories: [
          { id: 1, woIds: '101000071,205000076', size: 30 },
          { id: 101000080, woIds: '205000081,205000082', size: 4 },
          { id: 101000080, woIds: '', size: 4 },
          { id: 107000083, size: 4 },
          { id: 205000084, woIds: '', size: 4 },
        ],
      },
    })
    expect(o.collectedSceneIds).toEqual([101000069, 101000070, 101000071, 101000078])
    expect(o.lootedSceneInventoryIds).toEqual([101000080, 107000083])
    expect(o.counts.collected).toBe(4)
    expect(o.counts.looted).toBe(2)
  })

  it('passes version / startPlanet / randomizeMineables and parse warnings through', () => {
    const o = overlayOf({
      sections: {
        meta: [{ saveDisplayName: 'Fake', planetId: 'Prime', version: '9.2', worldSeed: 3, randomizeMineables: true }],
        worldObjects: ['{broken', { gId: 'FakeNoId', pos: '1,2,3' }],
      },
    })
    expect(o.version).toBe('9.2')
    expect(o.startPlanet).toBe('Prime')
    expect(o.randomizeMineables).toBe(true)
    expect(o.warnings[0]).toMatch(/not valid JSON/)
    expect(o.warnings).toContain('1 world object(s) without a valid id skipped.')
  })
})

describe('performance smoke', () => {
  it('parses and overlays a 200k-object save in < 5 s', () => {
    const n = 200_000
    const bulk = bulkSections(n)
    const text = buildSaveText({ bom: true, sections: { worldObjects: bulk.worldObjects, inventories: bulk.inventories } })
    const t0 = performance.now()
    const parsed = parseSave(decodeSaveBytes(new TextEncoder().encode(text)))
    const o = buildSaveOverlay(parsed, WORLDS)
    const ms = performance.now() - t0
    expect(parsed.worldObjects).toHaveLength(n)
    expect(o.counts.placed).toBe(bulk.expect.placed)
    expect(o.worlds.Prime.objects).toHaveLength(bulk.expect.placed)
    expect(o.collectedSceneIds).toHaveLength(bulk.expect.collected)
    expect(ms).toBeLessThan(5000)
  })
})
