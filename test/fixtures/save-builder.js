// Synthetic Planet Crafter save builder for tests. Every value is invented (Fake* gIds where the gId
// does not matter, made-up names, seeds and coordinates); nothing is copied from a real save.
//
// Native framing, as the game writes it:
//   [BOM] "\r" s0 "\r@\r" s1 ... "\r@\r" sN "\r@"     records inside a section joined by "|\n"

import { planetHash } from '../../src/lib/planets.js'

/** Line-ending variants. 'native' is byte-exact game output; the others simulate converted files. */
export const EOL = {
  native: { prefix: '\r', section: '\r@\r', suffix: '\r@', record: '|\n' },
  crlf: { prefix: '\r\n', section: '\r\n@\r\n', suffix: '\r\n@', record: '|\r\n' },
  lf: { prefix: '\n', section: '\n@\n', suffix: '\n@', record: '|\n' },
}

/** Section names in positional order, keyed by layout (= section count). */
export const LAYOUT_SECTIONS = {
  10: ['worldState', 'terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages',
    'storyEvents', 'meta', 'instances'],
  11: ['worldState', 'terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages',
    'storyEvents', 'meta', 'layers', 'instances'],
  9: ['terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages', 'storyEvents',
    'meta', 'layers'],
}

export const FAKE_PRIME = planetHash('Prime')

/**
 * Minimal plausible content for every section of a layout. World objects and instances are empty.
 * @param {9|10|11} [layout]
 * @returns {Record<string, Array<object|string>>}
 */
export function defaultSections(layout = 10) {
  const common = {
    worldObjects: [],
    inventories: [{ id: 1, woIds: '', size: 30 }, { id: 2, woIds: '', size: 6 }],
    stats: [{ craftedObjects: 7, totalSaveFileLoad: 3, totalSaveFileTime: 4242 }],
    messages: [{ stringId: 'fake_message_one', isRead: true }],
    storyEvents: [{ stringId: 'fake_story_event_one' }],
    layers: [{ layerId: 'FakeLayer1', colorBase: '1-1-1-1', colorCustom: '0-0-0-0', colorBaseLerp: 0, colorCustomLerp: 0 }],
  }
  if (layout === 9) {
    return {
      ...common,
      terraformation: [{ unitOxygenLevel: 1.5, unitHeatLevel: 2.5, unitPressureLevel: 3.5, unitBiomassLevel: 4.5 }],
      players: [{ playerPosition: '11,22,33', playerRotation: '0,0,0,1', playerInventoryId: 1, playerEquipmentId: 2,
        playerGaugeOxygen: 100.5, unlockedGroups: 'FakeUnlockA,FakeUnlockB' }],
      meta: [{ mode: 'Standard' }],
    }
  }
  return {
    ...common,
    worldState: [{ terraTokens: 1234, allTimeTerraTokens: 5678, unlockedGroups: 'FakeUnlockA,FakeUnlockB',
      openedInstanceSeed: 0, openedInstanceTimeLeft: 0 }],
    terraformation: [{ planetId: 'Prime', unitOxygenLevel: 1.5, unitHeatLevel: 2.5, unitPressureLevel: 3.5,
      unitPlantsLevel: 0.5, unitInsectsLevel: 0.25, unitAnimalsLevel: 0.125, unitPurificationLevel: -1.0 }],
    players: [{ id: 0, name: 'Test Pilot', inventoryId: 1, equipmentId: 2, playerPosition: '10.5,20.25,-30.75',
      playerRotation: '0,0,0,1', host: true, planetId: 'Prime' }],
    meta: [{ saveDisplayName: 'Synthetic Test Save', planetId: 'Prime', version: '9.999', mode: 'Standard',
      worldSeed: 424242, randomizeMineables: false }],
    instances: [],
  }
}

/**
 * Builds save text. Records may be objects (JSON.stringify'd) or raw strings (inserted verbatim, e.g.
 * to keep exact number text or to inject a broken record).
 * @param {object} [opts]
 * @param {9|10|11} [opts.layout] section layout (default 10)
 * @param {boolean} [opts.bom] prepend U+FEFF (encoded as EF BB BF by buildSaveBytes)
 * @param {'native'|'crlf'|'lf'} [opts.eol]
 * @param {Record<string, Array<object|string>>} [opts.sections] per-name overrides; [] = empty section
 * @param {string[]} [opts.order] section names to emit instead of the layout's (unknown names default to [])
 * @param {boolean} [opts.terminator] emit the final "\r@" (default true)
 * @param {string} [opts.trailer] text appended after everything (e.g. trailing whitespace)
 * @returns {string}
 */
export function buildSaveText({ layout = 10, bom = false, eol = 'native', sections = {}, order, terminator = true,
  trailer = '' } = {}) {
  const names = order ?? LAYOUT_SECTIONS[layout]
  if (!names) throw new Error(`unknown layout ${layout}`)
  const f = EOL[eol]
  const defaults = defaultSections(layout)
  const body = names
    .map((name) => (sections[name] ?? defaults[name] ?? [])
      .map((rec) => (typeof rec === 'string' ? rec : JSON.stringify(rec)))
      .join(f.record))
    .join(f.section)
  return (bom ? '﻿' : '') + f.prefix + body + (terminator ? f.suffix : '') + trailer
}

/**
 * Same as buildSaveText, UTF-8 encoded.
 * @param {Parameters<typeof buildSaveText>[0]} [opts]
 * @returns {Uint8Array}
 */
export function buildSaveBytes(opts) {
  return new TextEncoder().encode(buildSaveText(opts))
}

/**
 * Bulk synthetic world objects + inventories for performance tests, as raw record strings.
 * Pattern per 4 records: placed runtime build, bare scene record, runtime item held in an
 * inventory, placed scene object with state.
 * @param {number} count
 * @returns {{ worldObjects: string[], inventories: string[], expect: { placed: number, collected: number } }}
 */
export function bulkSections(count) {
  const worldObjects = new Array(count)
  const held = []
  let placed = 0
  let collected = 0
  for (let i = 0; i < count; i++) {
    const x = ((i * 37) % 4000) - 2000 + 0.5
    const z = ((i * 91) % 4000) - 2000 - 0.25
    switch (i % 4) {
      case 0:
        placed++
        worldObjects[i] = `{"id":${200_000_000 + i},"gId":"FakeFoundation","pos":"${x},12.5,${z}",` +
          `"rot":"0,0.7071068,0,0.7071068","planet":${FAKE_PRIME}}`
        break
      case 1:
        collected++
        worldObjects[i] = `{"id":${100_000_000 + i},"gId":"FakeOre"}`
        break
      case 2:
        held.push(200_000_000 + i)
        worldObjects[i] = `{"id":${200_000_000 + i},"gId":"FakeItem"}`
        break
      default:
        placed++
        worldObjects[i] = `{"id":${100_000_000 + i},"gId":"FakeCrate","liId":${100_000_000 + i},` +
          `"pos":"${x},-4.371139E-08,${z}","planet":${FAKE_PRIME}}`
    }
  }
  const inventories = []
  for (let i = 0; i < held.length; i += 50) {
    inventories.push(`{"id":${10 + inventories.length},"woIds":"${held.slice(i, i + 50).join(',')}","size":50}`)
  }
  return { worldObjects, inventories, expect: { placed, collected } }
}
