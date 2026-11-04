// Client-side parser for The Planet Crafter save files. Pure: no DOM, safe in Node and the browser.
//
// Re-implemented from documented facts about the format (see docs/ARCHITECTURE.md); no code is
// copied from other save tools. The file is UTF-8 text, not one JSON document:
//
//   [BOM] "\r" section0 "\r@\r" section1 "\r@\r" ... sectionN "\r@"
//
// Records inside a list section are joined by "|\n" and each record is one JSON object. We split on
// '@' and '|' only OUTSIDE JSON strings (a scanner that honours backslash escapes), so any line-ending
// style (CR, CRLF, LF) works and an '@' or '|' typed into a sign or a player name cannot break framing.
//
// Known layouts (keyed by section count, verified against the content of each section):
//   10 'current'                 world state, terraformation, players, world objects, inventories,
//                                stats, messages, story events, metadata, procedural instances
//   11 'legacy-terrain-layers'   as current, plus colour layers ({layerId,...}) at index 9, which
//                                shifts procedural instances to index 10
//    9 'legacy-2022'             single planet: unit levels, player, world objects, inventories, stats,
//                                messages, story events, game mode ({mode}), colour layers
// Anything else is 'unknown' and is still read section by section from content markers.

import { RUNTIME_ID_MIN, isSceneId, planetHash } from './planets.js'

/** Thrown when bytes or text are structurally not a readable save (as opposed to one bad record). */
export class SaveFormatError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'SaveFormatError'
  }
}

/**
 * @typedef {'current'|'legacy-terrain-layers'|'legacy-2022'|'unknown'} SaveLayout
 * @typedef {'worldState'|'terraformation'|'players'|'worldObjects'|'inventories'|'stats'|'messages'
 *   |'storyEvents'|'meta'|'layers'|'instances'|'unknown'} SectionKind
 * @typedef {Record<string, any>} SaveRecord one JSON object exactly as written (unknown keys kept)
 *
 * @typedef {object} ParsedSave
 * @property {SaveLayout} layout
 * @property {number} sectionCount
 * @property {SectionKind[]} sectionKinds kind of each section (content-detected; position for empty ones)
 * @property {SaveRecord} meta metadata / game-settings record ({} when absent)
 * @property {string} startPlanet `meta.planetId`, or 'Prime' when empty (legacy single-planet saves)
 * @property {string|null} version `meta.version`, e.g. "2.103", or null
 * @property {boolean} randomizeMineables
 * @property {SaveRecord[]} players NB: Steam player ids exceed MAX_SAFE_INTEGER; never key on `id`
 * @property {SaveRecord[]} worldObjects
 * @property {SaveRecord[]} inventories
 * @property {SaveRecord[]} instances procedural wreck instances
 * @property {SaveRecord[]} terraformation one record per planet (legacy: one record without planetId)
 * @property {string[]} warnings
 *
 * @typedef {'built'|'wreck'|'scene'|'unknown'} ObjectOrigin
 * @typedef {{ name: string, x: number, y: number, z: number }} OverlayPlayer
 * @typedef {{ id: number, gId: string, x: number, y: number, z: number, origin: ObjectOrigin }} OverlayObject
 * @typedef {{ x: number, y: number, z: number, seed: number|null, index: number|null }} OverlayInstance
 * @typedef {{ players: OverlayPlayer[], objects: OverlayObject[], instances: OverlayInstance[] }} OverlayWorld
 *
 * @typedef {object} SaveOverlayCounts
 * @property {number} worldObjects world-object records in the save
 * @property {number} placed records with a real position (excludes (0,0,0) and the -500 sentinel)
 * @property {number} sentinel records parked at (-500,-500,-500)
 * @property {number} objects placed objects emitted into `worlds`
 * @property {number} players players emitted into `worlds`
 * @property {number} instances procedural instances emitted into `worlds`
 * @property {number} unknownPlanet placed objects / instances / players skipped: planet not in worldIds
 * @property {number} collected length of `collectedSceneIds`
 * @property {number} looted length of `lootedSceneInventoryIds`
 * @property {Record<ObjectOrigin, number>} byOrigin emitted objects per origin
 *
 * @typedef {object} SaveOverlay
 * @property {string|null} version
 * @property {string} startPlanet
 * @property {boolean} randomizeMineables
 * @property {Record<string, OverlayWorld>} worlds one entry per requested world id (always present)
 * @property {number[]} collectedSceneIds sorted, see {@link buildSaveOverlay}
 * @property {number[]} lootedSceneInventoryIds sorted, see {@link buildSaveOverlay}
 * @property {number[]} unknownPlanetHashes sorted, deduped
 * @property {SaveOverlayCounts} counts
 * @property {string[]} warnings parse warnings followed by overlay warnings
 */

// ---------------------------------------------------------------------------------------------
// Bytes -> text

/**
 * Decodes save-file bytes as strict UTF-8 and strips one leading BOM. The game writes UTF-8 (Steam
 * with a BOM, Game Pass without); a UTF-16/32 file has been re-encoded by some other program.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {string}
 * @throws {SaveFormatError} on a UTF-16/32 byte-order mark, NUL bytes at the start, or invalid UTF-8
 */
export function decodeSaveBytes(bytes) {
  const u8 = toUint8(bytes)
  const enc = sniffWideEncoding(u8)
  if (enc) {
    throw new SaveFormatError(`This file is ${enc}. Planet Crafter saves are UTF-8 text; ` +
      'it was probably re-saved by another program. Use the original save file.')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(u8)
  } catch {
    throw new SaveFormatError('This file is not valid UTF-8 text, so it is not a Planet Crafter save ' +
      '(or it is damaged).')
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** @param {unknown} bytes */
function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (Object.prototype.toString.call(bytes) === '[object ArrayBuffer]') {
    return new Uint8Array(/** @type {ArrayBuffer} */ (bytes))
  }
  throw new TypeError('decodeSaveBytes expects an ArrayBuffer or a Uint8Array')
}

/** @param {Uint8Array} b @returns {string|null} a description of the wide encoding found */
function sniffWideEncoding(b) {
  if (b[0] === 0xff && b[1] === 0xfe) {
    return b[2] === 0 && b[3] === 0
      ? 'UTF-32 LE (it starts with the byte-order mark FF FE 00 00)'
      : 'UTF-16 LE (it starts with the byte-order mark FF FE)'
  }
  if (b[0] === 0xfe && b[1] === 0xff) return 'UTF-16 BE (it starts with the byte-order mark FE FF)'
  if (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) {
    return 'UTF-32 BE (it starts with the byte-order mark 00 00 FE FF)'
  }
  const start = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0
  for (let i = start; i < Math.min(b.length, start + 4); i++) {
    if (b[i] === 0) return 'UTF-16 or UTF-32 without a byte-order mark (it has NUL bytes at the start)'
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Framing

const QUOTE = 0x22
const BACKSLASH = 0x5c
const AT = 0x40
const PIPE = 0x7c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const SNIFF_LIMIT = 1 << 20

/** @param {number} c */
const isWs = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xfeff

/**
 * Cheap sniff: does this text look like a save (rather than a pcmap-dump JSON, a CSV or other JSON)?
 * True when the text starts with a JSON object and the first '@' outside JSON strings (looked for in
 * the first 1 MiB) directly follows that object's closing brace. Valid JSON never has an '@' outside
 * a string, and CSV does not start with '{'.
 * @param {string} text
 * @returns {boolean}
 */
export function isSaveText(text) {
  if (typeof text !== 'string') return false
  const n = text.length
  let i = 0
  while (i < n && isWs(text.charCodeAt(i))) i++
  if (text.charCodeAt(i) !== OPEN_BRACE) return false
  const end = Math.min(n, i + SNIFF_LIMIT)
  let inStr = false
  let last = 0
  for (; i < end; i++) {
    const c = text.charCodeAt(i)
    if (inStr) {
      if (c === BACKSLASH) i++
      else if (c === QUOTE) { inStr = false; last = QUOTE }
      continue
    }
    if (c === QUOTE) inStr = true
    else if (c === AT) return last === CLOSE_BRACE
    else if (!isWs(c)) last = c
  }
  return false
}

/**
 * Splits save text into sections of raw record strings (trimmed, empty ones dropped). '@' separates
 * sections and '|' separates records, but only outside JSON strings. The whitespace-only tail after
 * the final '@' terminator is not a section. Single pass, linear time.
 * @param {string} text
 * @returns {string[][]}
 */
function splitSections(text) {
  /** @type {string[][]} */
  const sections = []
  /** @type {string[]} */
  let records = []
  let start = 0
  let inStr = false
  let strStart = 0
  const n = text.length
  const flush = (/** @type {number} */ end) => {
    const rec = text.slice(start, end).trim()
    if (rec !== '') records.push(rec)
  }
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (inStr) {
      if (c === BACKSLASH) i++
      else if (c === QUOTE) inStr = false
      continue
    }
    if (c === QUOTE) {
      inStr = true
      strStart = i
    } else if (c === PIPE || c === AT) {
      flush(i)
      start = i + 1
      if (c === AT) {
        sections.push(records)
        records = []
      }
    }
  }
  if (inStr) {
    throw new SaveFormatError(`The save is damaged: a text value starting at character ${strStart} never ends.`)
  }
  flush(n)
  if (records.length > 0 || sections.length === 0) sections.push(records)
  return sections
}

// ---------------------------------------------------------------------------------------------
// Sections

/** @type {Record<number, {name: SaveLayout, kinds: SectionKind[]}>} */
const LAYOUTS = {
  10: {
    name: 'current',
    kinds: ['worldState', 'terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages',
      'storyEvents', 'meta', 'instances'],
  },
  11: {
    name: 'legacy-terrain-layers',
    kinds: ['worldState', 'terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages',
      'storyEvents', 'meta', 'layers', 'instances'],
  },
  9: {
    name: 'legacy-2022',
    kinds: ['terraformation', 'players', 'worldObjects', 'inventories', 'stats', 'messages', 'storyEvents',
      'meta', 'layers'],
  },
}

/** @param {object} o @param {string} k */
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * Section kind from the marker keys of one record. Order matters: e.g. a 2022 player record also
 * carries unlockedGroups, and an in-between world-state record also carries unit levels.
 * @param {SaveRecord} r
 * @returns {SectionKind}
 */
function classifyRecord(r) {
  if (has(r, 'layerId')) return 'layers'
  if (has(r, 'playerPosition')) return 'players'
  if (has(r, 'gId')) return 'worldObjects'
  if (has(r, 'woIds') || (has(r, 'id') && has(r, 'size'))) return 'inventories'
  if (has(r, 'unitOxygenLevel')) return 'terraformation'
  if (has(r, 'isRead')) return 'messages'
  if (has(r, 'stringId')) return 'storyEvents'
  if (has(r, 'craftedObjects')) return 'stats'
  if (has(r, 'terraTokens') || has(r, 'unlockedGroups')) return 'worldState'
  if (has(r, 'worldSeed') || has(r, 'saveDisplayName') || has(r, 'mode')) return 'meta'
  if (has(r, 'owner') && has(r, 'seed')) return 'instances'
  return 'unknown'
}

const MAX_RECORD_WARNINGS = 20

/**
 * Parses a save's text (BOM optional). A single unparsable record becomes a warning and is skipped;
 * a structurally unreadable file throws.
 * @param {string} text
 * @returns {ParsedSave}
 * @throws {SaveFormatError}
 */
export function parseSave(text) {
  if (typeof text !== 'string') throw new TypeError('parseSave expects a string')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.trim() === '') throw new SaveFormatError('The file is empty.')

  const raw = splitSections(text)
  const sectionCount = raw.length
  if (sectionCount < 2) {
    throw new SaveFormatError('This is not a Planet Crafter save: it has no "@" section separators.')
  }

  /** @type {string[]} */
  const warnings = []
  let badRecords = 0
  /** @type {SaveRecord[][]} */
  const sections = raw.map((recs, s) => {
    /** @type {SaveRecord[]} */
    const out = []
    for (let r = 0; r < recs.length; r++) {
      let v
      let problem = ''
      try {
        v = JSON.parse(recs[r])
        if (v === null || typeof v !== 'object' || Array.isArray(v)) problem = 'not a JSON object'
      } catch (e) {
        problem = `not valid JSON (${/** @type {Error} */ (e).message})`
      }
      if (problem) {
        if (++badRecords <= MAX_RECORD_WARNINGS) warnings.push(`Section ${s}, record ${r}: ${problem}; skipped.`)
        continue
      }
      out.push(v)
    }
    return out
  })
  if (badRecords > MAX_RECORD_WARNINGS) {
    warnings.push(`...and ${badRecords - MAX_RECORD_WARNINGS} more unreadable records skipped.`)
  }

  /** @type {(SectionKind|null)[]} */
  const detected = sections.map((recs) => (recs.length ? classifyRecord(recs[0]) : null))
  if (!detected.some((k) => k !== null && k !== 'unknown')) {
    throw new SaveFormatError(`This is not a Planet Crafter save: none of its ${sectionCount} sections ` +
      'holds recognisable save data.')
  }

  let def = LAYOUTS[sectionCount] ?? null
  if (!def) {
    warnings.push(`Unexpected section count ${sectionCount} (expected 9, 10 or 11); reading sections by content.`)
  } else {
    const kinds = def.kinds
    const bad = detected.findIndex((k, i) => k !== null && k !== 'unknown' && k !== kinds[i])
    if (bad >= 0) {
      warnings.push(`Section ${bad} holds ${detected[bad]} data, where a ${sectionCount}-section save has ` +
        `${kinds[bad]}; reading sections by content.`)
      def = null
    }
  }

  /** @type {SectionKind[]} */
  const sectionKinds = detected.map((k, i) => {
    if (k !== null && k !== 'unknown') return k
    if (!def) return 'unknown'
    if (k === 'unknown') warnings.push(`Section ${i}: content not recognised; treating it as ${def.kinds[i]} by position.`)
    return def.kinds[i]
  })

  /** @type {Map<SectionKind, SaveRecord[]>} */
  const byKind = new Map()
  sectionKinds.forEach((k, i) => {
    if (k === 'unknown') return
    const prev = byKind.get(k)
    if (!prev) {
      byKind.set(k, sections[i])
      return
    }
    warnings.push(`Section ${i} is a second ${k} section; its records are appended.`)
    for (const rec of sections[i]) prev.push(rec)
  })
  /** @param {SectionKind} k */
  const list = (k) => byKind.get(k) ?? []

  const meta = list('meta')[0] ?? {}
  const startPlanet = typeof meta.planetId === 'string' && meta.planetId.trim() !== '' ? meta.planetId : 'Prime'
  return {
    layout: def ? def.name : 'unknown',
    sectionCount,
    sectionKinds,
    meta,
    startPlanet,
    version: meta.version == null ? null : String(meta.version),
    randomizeMineables: meta.randomizeMineables === true,
    players: list('players'),
    worldObjects: list('worldObjects'),
    inventories: list('inventories'),
    instances: list('instances'),
    terraformation: list('terraformation'),
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// Overlay

/**
 * "x,y,z" -> numbers. Components are Mono float text: bare ints ("161") and exponents
 * ("-4.371139E-08") both occur, so each is read with Number(). Empty components are rejected.
 * @param {unknown} s
 * @returns {[number, number, number]|null}
 */
function parseVec3(s) {
  if (typeof s !== 'string') return null
  const p = s.split(',')
  if (p.length !== 3 || p[0].trim() === '' || p[1].trim() === '' || p[2].trim() === '') return null
  const x = Number(p[0])
  const y = Number(p[1])
  const z = Number(p[2])
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null
}

/** (0,0,0) means "not in the world"; (-500,-500,-500) parks launched rockets / space multipliers. */
const isPlacedVec = (/** @type {[number, number, number]} */ [x, y, z]) =>
  !(x === 0 && y === 0 && z === 0) && !(x === -500 && y === -500 && z === -500)

/** @param {unknown} v @returns {number|null} */
function toInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

/** @param {unknown} v @returns {number|null} */
const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Integer ids from a comma-separated list such as `woIds` / `woIdsGenerated` (arrays accepted too).
 * @param {unknown} v
 * @param {Set<number>} into
 */
function addIds(v, into) {
  const parts = typeof v === 'string' ? (v === '' ? [] : v.split(',')) : Array.isArray(v) ? v : []
  for (const p of parts) {
    const id = toInt(p)
    if (id !== null) into.add(id)
  }
}

/**
 * A field value the game treats as "unset": current saves omit such fields, 2022 saves wrote them
 * explicitly (e.g. "liId":0, "pos":"0,0,0", "wear":0).
 * @param {unknown} v
 */
function isDefaultValue(v) {
  if (v === null || v === false || v === 0 || v === '') return true
  if (typeof v !== 'string') return false
  if (v === '0,0,0,1') return true // identity rotation
  const parts = v.split(',')
  return parts.every((p) => p.trim() !== '' && Number(p) === 0)
}

/** Only `id` and `gId` carry information: the record says nothing but "this scene id was touched". */
function isBareRecord(/** @type {SaveRecord} */ wo) {
  for (const k in wo) {
    if (k !== 'id' && k !== 'gId' && has(wo, k) && !isDefaultValue(wo[k])) return false
  }
  return true
}

// Origin rule from published save-format research (wreck-only gId prefixes; runtime-id gIds that
// also spawn inside wrecks), re-implemented here.
const WRECK_PREFIXES = ['ProceduralWreck', 'WreckEntryLocked', 'WreckFusionGenerator']
const ALSO_SPAWNS_IN_WRECKS = new Set(['Counter1', 'Counter2', 'Fridge1', 'Vault1'])

/**
 * @param {number} id
 * @param {string} gId
 * @param {Set<number>} generated ids listed in any procedural instance's woIdsGenerated
 * @returns {ObjectOrigin}
 */
function classifyOrigin(id, gId, generated) {
  if (generated.has(id) || WRECK_PREFIXES.some((p) => gId.startsWith(p))) return 'wreck'
  if (id >= RUNTIME_ID_MIN && !ALSO_SPAWNS_IN_WRECKS.has(gId)) return 'built'
  if (isSceneId(id)) return 'scene'
  return 'unknown'
}

/**
 * Turns a parsed save into per-world map layers. Linear time (Sets/Maps only).
 *
 * - **objects**: world objects that are *placed*: `pos` parses to finite numbers and is neither
 *   (0,0,0) nor the (-500,-500,-500) sentinel. `planet` (a planet-id hash) selects the world; a
 *   missing or 0 planet means `startPlanet`. Hashes that match no requested world are reported in
 *   `unknownPlanetHashes` and the object is skipped. `origin` is 'wreck' (wreck-only gId prefix, or
 *   listed in a procedural instance's `woIdsGenerated`), else 'built' (runtime id, gId not one that
 *   also spawns in wrecks), else 'scene' (scene id range), else 'unknown'. Section 9 can be empty or
 *   incomplete, so 'built' is a best guess.
 * - **players**: `playerPosition` on `planetId` (empty means `startPlanet`). Never keyed on the
 *   player id (Steam ids lose precision as JS numbers).
 * - **instances**: procedural wreck instances with a placed `pos`, plus `seed` and `index`.
 * - **collectedSceneIds**: scene-range ids whose record is *bare* (no field other than `id`/`gId`
 *   with a non-default value), not placed, and not listed in any inventory's `woIds`. Meaning: the
 *   object is absent from the world, i.e. it was mined, picked or destroyed, OR it is a
 *   random-appearance object whose roll failed. Records carrying state (grwth, liId, ...) are
 *   ambiguous and excluded. Untouched scene objects are not in the save at all, so this list says
 *   nothing about them; join it with a scene-id dataset for positions.
 * - **lootedSceneInventoryIds**: inventory records whose id is in the scene range. A scene container
 *   uses its own world-object id as its inventory id, and its inventory is only saved once it was
 *   generated or changed, so this is an *inferred* "opened / changed scene container" signal.
 *
 * @param {ParsedSave} parsed
 * @param {string[]} worldIds world ids to resolve planet hashes against, e.g. ['Prime', 'Humble']
 * @returns {SaveOverlay}
 */
export function buildSaveOverlay(parsed, worldIds) {
  const warnings = [...parsed.warnings]
  const startPlanet = parsed.startPlanet
  const startHash = planetHash(startPlanet)

  /** @type {Record<string, OverlayWorld>} */
  const worlds = {}
  /** @type {Map<string, OverlayWorld>} */
  const worldById = new Map()
  /** @type {Map<number, OverlayWorld>} */
  const worldByHash = new Map()
  for (const id of worldIds) {
    const w = { players: [], objects: [], instances: [] }
    worlds[id] = w
    worldById.set(id, w)
    worldByHash.set(planetHash(id), w)
  }

  /** @type {Set<number>} */
  const unknownHashes = new Set()
  let unknownPlanet = 0
  /** @param {unknown} planet @returns {OverlayWorld|null} */
  const worldOf = (planet) => {
    const h = toInt(planet)
    const hash = h === null || h === 0 ? startHash : h
    const w = worldByHash.get(hash)
    if (w) return w
    unknownHashes.add(hash)
    unknownPlanet++
    return null
  }

  /** @type {Set<number>} */
  const inInventory = new Set()
  /** @type {number[]} */
  const looted = []
  for (const inv of parsed.inventories) {
    addIds(inv.woIds, inInventory)
    const id = toInt(inv.id)
    if (id !== null && isSceneId(id)) looted.push(id)
  }

  /** @type {Set<number>} */
  const generated = new Set()
  for (const inst of parsed.instances) addIds(inst.woIdsGenerated, generated)

  const counts = {
    worldObjects: parsed.worldObjects.length,
    placed: 0,
    sentinel: 0,
    objects: 0,
    players: 0,
    instances: 0,
    unknownPlanet: 0,
    collected: 0,
    looted: 0,
    byOrigin: { built: 0, wreck: 0, scene: 0, unknown: 0 },
  }

  /** @type {Set<number>} */
  const placedIds = new Set()
  /** @type {number[]} */
  const bareScene = []
  let noId = 0
  for (const wo of parsed.worldObjects) {
    const id = toInt(wo.id)
    if (id === null) {
      noId++
      continue
    }
    const pos = parseVec3(wo.pos)
    if (pos && isPlacedVec(pos)) {
      counts.placed++
      placedIds.add(id)
      const w = worldOf(wo.planet)
      if (!w) continue
      const gId = typeof wo.gId === 'string' ? wo.gId : ''
      const origin = classifyOrigin(id, gId, generated)
      counts.byOrigin[origin]++
      w.objects.push({ id, gId, x: pos[0], y: pos[1], z: pos[2], origin })
    } else {
      if (pos && pos[0] === -500 && pos[1] === -500 && pos[2] === -500) counts.sentinel++
      if (isSceneId(id) && isBareRecord(wo)) bareScene.push(id)
    }
  }
  if (noId) warnings.push(`${noId} world object(s) without a valid id skipped.`)

  let badPlayers = 0
  for (const p of parsed.players) {
    const pos = parseVec3(p.playerPosition)
    if (!pos) {
      badPlayers++
      continue
    }
    const planetId = typeof p.planetId === 'string' && p.planetId.trim() !== '' ? p.planetId : startPlanet
    const w = worldById.get(planetId)
    if (!w) {
      unknownHashes.add(planetHash(planetId))
      unknownPlanet++
      continue
    }
    w.players.push({ name: typeof p.name === 'string' ? p.name : '', x: pos[0], y: pos[1], z: pos[2] })
  }
  if (badPlayers) warnings.push(`${badPlayers} player(s) without a readable position skipped.`)

  for (const inst of parsed.instances) {
    const pos = parseVec3(inst.pos)
    if (!pos || !isPlacedVec(pos)) continue
    const w = worldOf(inst.planet)
    if (!w) continue
    w.instances.push({ x: pos[0], y: pos[1], z: pos[2], seed: toNum(inst.seed), index: toNum(inst.index) })
  }

  for (const w of worldById.values()) {
    counts.objects += w.objects.length
    counts.players += w.players.length
    counts.instances += w.instances.length
  }

  const collectedSceneIds = sortedUnique(bareScene.filter((id) => !placedIds.has(id) && !inInventory.has(id)))
  const lootedSceneInventoryIds = sortedUnique(looted)
  const unknownPlanetHashes = sortedUnique([...unknownHashes])
  counts.unknownPlanet = unknownPlanet
  counts.collected = collectedSceneIds.length
  counts.looted = lootedSceneInventoryIds.length
  if (unknownPlanet) {
    warnings.push(`${unknownPlanet} item(s) on unrecognised planet(s) skipped (planet hashes ` +
      `${unknownPlanetHashes.join(', ')}).`)
  }

  return {
    version: parsed.version,
    startPlanet,
    randomizeMineables: parsed.randomizeMineables,
    worlds,
    collectedSceneIds,
    lootedSceneInventoryIds,
    unknownPlanetHashes,
    counts,
    warnings,
  }
}

/** @param {number[]} ids */
function sortedUnique(ids) {
  return [...new Set(ids)].sort((a, b) => a - b)
}
