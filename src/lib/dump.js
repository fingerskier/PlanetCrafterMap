// POI dump reader, validator, merger and world-data writer. Pure: no DOM, safe in Node and the browser.
//
// A dump is the per-planet list of developer-placed scene objects that `tools/dumper` (or any other
// tool) writes, either as `pcmap-dump/1` JSON or as CSV. The formats are specified in
// docs/ARCHITECTURE.md. The same code runs in scripts/build-data.mjs and in the page (dump import).

import { RUNTIME_ID_MIN } from './planets.js'

export const DUMP_FORMAT = 'pcmap-dump/1'
export const WORLD_FORMAT = 'pcmap-world/1'
/** At most this many per-object messages are listed; a summary line reports the total. */
export const MAX_LISTED = 20
/** Saves park objects that are in orbit at this position (research notes); they have no map position. */
const SPACE_SENTINEL = -500

/** Thrown when text is structurally unreadable (bad JSON, no CSV header, ...), not for one bad object. */
export class DumpParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DumpParseError'
  }
}

/**
 * @typedef {{ id: number|null, gId: string, x: number, y: number, z: number }} DumpObject
 * @typedef {object} NormalizedDump
 * @property {string} planet world id, e.g. "Prime" (case-sensitive)
 * @property {string|null} gameVersion
 * @property {boolean|null} randomizeMineables null when unknown
 * @property {string|null} source tool that wrote the dump
 * @property {DumpObject[]} objects
 *
 * @typedef {object} MergedDumps
 * @property {string} planet
 * @property {DumpObject[]} objects de-duplicated, first occurrence wins, in input order
 * @property {{ input: number, unique: number, duplicates: number, conflicts: number }} stats
 * @property {string[]} warnings
 * @property {string[]} gameVersions distinct non-null game versions, sorted
 * @property {boolean|null} randomizeMineables true if any dump is true, else false if any is false, else null
 * @property {string[]} sources distinct non-null sources, sorted
 *
 * @typedef {object} WorldData pcmap-world/1 without `rev`
 * @property {string} format
 * @property {string} world
 * @property {string|null} gameVersion
 * @property {boolean|null} randomizeMineables
 * @property {string[]} sources
 * @property {string[]} gids sorted
 * @property {[number, number, number, number, number][]} points [gidIndex, x, y, z, id]
 */

/**
 * Parse dump text as JSON or CSV. The file extension decides when there is one (.json / .csv);
 * otherwise the content does (a leading `{` or `[` means JSON). A UTF-8 BOM is ignored.
 * CSV becomes a pcmap-dump/1-shaped object for {@link validateDump}; malformed rows are left for
 * the validator to report, but an unreadable structure throws.
 * @param {string} text
 * @param {string} [filename] used for format detection and error messages
 * @returns {unknown}
 * @throws {DumpParseError}
 */
export function parseDumpText(text, filename) {
  const where = filename ? `${filename}: ` : ''
  if (typeof text !== 'string') throw new DumpParseError(`${where}expected text`)
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (!src.trim()) throw new DumpParseError(`${where}file is empty`)
  const ext = /\.([a-z0-9]+)$/i.exec(filename ?? '')?.[1]?.toLowerCase()
  const kind = ext === 'json' || ext === 'csv' ? ext : /^\s*[{[]/.test(src) ? 'json' : 'csv'
  if (kind === 'json') {
    try {
      return JSON.parse(src)
    } catch (e) {
      throw new DumpParseError(`${where}invalid JSON: ${/** @type {Error} */ (e).message}`)
    }
  }
  return parseCsvDump(src, where)
}

/**
 * Check a parsed dump and normalize it. Any error makes `dump` null; per-object errors are
 * aggregated (the first {@link MAX_LISTED} are listed, then a total).
 * @param {unknown} raw output of {@link parseDumpText} or any object in pcmap-dump/1 shape
 * @param {{ defaultPlanet?: string }} [opts] planet to assume when the dump names none
 *   (e.g. from its `data/dumps/<WorldId>/` folder, or the world shown in the page)
 * @returns {{ dump: NormalizedDump|null, errors: string[], warnings: string[] }}
 */
export function validateDump(raw, opts = {}) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  if (!isObject(raw)) {
    return { dump: null, errors: [`a dump must be a JSON object with "planet" and "objects" (got ${show(raw)})`], warnings }
  }
  if (raw.format === undefined) warnings.push(`no "format" tag; assuming ${DUMP_FORMAT}`)
  else if (raw.format !== DUMP_FORMAT) errors.push(`unsupported format ${show(raw.format)} (expected "${DUMP_FORMAT}")`)

  const planet = raw.planet === undefined || raw.planet === null || raw.planet === '' ? opts.defaultPlanet : raw.planet
  if (typeof planet !== 'string' || !planet) {
    errors.push(`"planet" must be a world id such as "Prime" (got ${show(raw.planet)})`)
  }

  /** @type {string|null} */
  let gameVersion = null
  if (typeof raw.gameVersion === 'string' && raw.gameVersion.trim()) gameVersion = raw.gameVersion.trim()
  else if (typeof raw.gameVersion === 'number' && Number.isFinite(raw.gameVersion)) {
    gameVersion = String(raw.gameVersion)
    warnings.push(`"gameVersion" should be a string; read ${raw.gameVersion} as "${gameVersion}"`)
  } else if (raw.gameVersion != null && raw.gameVersion !== '') {
    warnings.push(`ignoring "gameVersion" ${show(raw.gameVersion)}: expected a string`)
  }

  /** @type {boolean|null} */
  let randomizeMineables = null
  if (typeof raw.randomizeMineables === 'boolean') randomizeMineables = raw.randomizeMineables
  else if (raw.randomizeMineables != null) {
    warnings.push(`ignoring "randomizeMineables" ${show(raw.randomizeMineables)}: expected true, false or null`)
  }
  if (randomizeMineables) {
    warnings.push('randomizeMineables is true: ore types in this dump were shuffled by the save settings ' +
      'and differ from a vanilla world; do not publish it')
  }

  /** @type {string|null} */
  let source = null
  if (typeof raw.source === 'string' && raw.source.trim()) source = raw.source.trim()
  else if (raw.source != null && raw.source !== '') warnings.push(`ignoring "source" ${show(raw.source)}: expected a string`)

  if (!Array.isArray(raw.objects)) {
    errors.push(`"objects" must be an array (got ${show(raw.objects)})`)
    return { dump: null, errors, warnings }
  }

  /** @type {DumpObject[]} */
  const objects = []
  /** @type {string[]} */
  const listed = []
  let invalid = 0
  let inSpace = 0
  raw.objects.forEach((/** @type {any} */ o, /** @type {number} */ i) => {
    const at = `objects[${i}]` + (isObject(o) && Number.isInteger(o.line) ? ` (line ${o.line})` : '')
    /** @type {string[]} */
    const problems = []
    if (!isObject(o)) problems.push(`must be an object (got ${show(o)})`)
    else {
      if (typeof o.gId !== 'string' || !o.gId || o.gId.trim() !== o.gId) {
        problems.push(`gId must be a non-empty string without surrounding spaces (got ${show(o.gId)})`)
      }
      if (o.id != null && !(Number.isSafeInteger(o.id) && o.id >= 0)) {
        problems.push(`id must be a non-negative integer or null (got ${show(o.id)})`)
      }
      if (!readPos(o.pos)) problems.push(`pos must be [x, y, z] finite numbers or an "x,y,z" string (got ${show(o.pos)})`)
    }
    if (problems.length) {
      invalid++
      if (listed.length < MAX_LISTED) listed.push(`${at}: ${problems.join('; ')}`)
      return
    }
    const [x, y, z] = /** @type {number[]} */ (readPos(o.pos))
    if (x === SPACE_SENTINEL && y === SPACE_SENTINEL && z === SPACE_SENTINEL) {
      inSpace++
      return
    }
    // id 0 is how tools write "unknown", and the world format uses 0 for it as well.
    objects.push({ id: o.id ? o.id : null, gId: o.gId, x, y, z })
  })
  if (invalid) {
    errors.push(...listed)
    errors.push(`${invalid} of ${raw.objects.length} object(s) are invalid` +
      (invalid > listed.length ? ` (only the first ${listed.length} are listed)` : ''))
  }
  if (inSpace) warnings.push(`dropped ${inSpace} object(s) at the in-space position -500,-500,-500`)
  if (!raw.objects.length) warnings.push('the dump has no objects')

  if (errors.length) return { dump: null, errors, warnings }
  return {
    dump: { planet: /** @type {string} */ (planet), gameVersion, randomizeMineables, source, objects },
    errors,
    warnings,
  }
}

/**
 * De-duplication key: the stable object id when known, else gId plus the rounded position.
 * @param {DumpObject} o
 */
export function dedupKey(o) {
  if (o.id != null) return `id:${o.id}`
  return `${o.gId}@${Math.round(o.x)}:${Math.round(o.y)}:${Math.round(o.z)}`
}

/**
 * Merge normalized dumps of ONE planet. The first occurrence of a key wins, in input order. A
 * duplicate whose gId differs, or whose position is more than `tolerance` units away, is a conflict:
 * it is counted and reported as a warning (the first {@link MAX_LISTED}), and still dropped.
 * @param {NormalizedDump[]} dumps
 * @param {{ planet?: string, tolerance?: number, names?: string[] }} [opts] `planet` is required
 *   when `dumps` is empty; `names` (parallel to `dumps`, e.g. file names) label conflict warnings
 * @returns {MergedDumps}
 * @throws {Error} when the dumps are not all for the same planet
 */
export function mergeDumps(dumps, opts = {}) {
  const { tolerance = 1, names = [] } = opts
  if (!Array.isArray(dumps)) throw new TypeError('mergeDumps: expected an array of normalized dumps')
  const planet = opts.planet ?? dumps[0]?.planet
  if (typeof planet !== 'string' || !planet) {
    throw new Error('mergeDumps: no planet to merge for (pass opts.planet when there are no dumps)')
  }
  const others = [...new Set(dumps.map((d) => d.planet).filter((p) => p !== planet))]
  if (others.length) {
    throw new Error(`mergeDumps: all dumps must be for the same planet; expected '${planet}', ` +
      `also got ${others.map((p) => `'${p}'`).join(', ')}`)
  }
  const label = (/** @type {number} */ i) => names[i] ?? `dump #${i + 1}`

  /** @type {Map<string, { o: DumpObject, from: number }>} */
  const seen = new Map()
  /** @type {DumpObject[]} */
  const objects = []
  /** @type {string[]} */
  const warnings = []
  let input = 0
  let conflicts = 0
  dumps.forEach((d, from) => {
    for (const o of d.objects) {
      input++
      const key = dedupKey(o)
      const prev = seen.get(key)
      if (!prev) {
        const copy = { id: o.id, gId: o.gId, x: o.x, y: o.y, z: o.z }
        seen.set(key, { o: copy, from })
        objects.push(copy)
        continue
      }
      const p = prev.o
      const delta = Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z)
      if (p.gId !== o.gId || delta > tolerance) {
        conflicts++
        if (conflicts <= MAX_LISTED) {
          warnings.push(`conflict on ${key}: kept ${p.gId} at ${fmtPos(p)} from ${label(prev.from)}, ` +
            `dropped ${o.gId} at ${fmtPos(o)} from ${label(from)} (${delta.toFixed(2)} units apart)`)
        }
      }
    }
  })
  if (conflicts > MAX_LISTED) warnings.push(`${conflicts} conflicts in total (only the first ${MAX_LISTED} are listed)`)

  const gameVersions = distinct(dumps.map((d) => d.gameVersion))
  if (gameVersions.length > 1) {
    warnings.push(`dumps come from ${gameVersions.length} game versions (${gameVersions.join(', ')}); gameVersion is left unset`)
  }
  const flags = dumps.map((d) => d.randomizeMineables)
  const randomizeMineables = flags.includes(true) ? true : flags.includes(false) ? false : null

  return {
    planet,
    objects,
    stats: { input, unique: objects.length, duplicates: input - objects.length, conflicts },
    warnings,
    gameVersions,
    randomizeMineables,
    sources: distinct(dumps.map((d) => d.source)),
  }
}

/**
 * Build the published pcmap-world/1 object (without `rev`, which the caller hashes and inserts).
 * Runtime objects (id >= RUNTIME_ID_MIN: player builds, procedural-wreck contents) are left out
 * unless `includeRuntime`. Coordinates are rounded to 0.1 and points sorted by (gId, x, z, y, id),
 * so the output depends only on the set of objects.
 * @param {MergedDumps} merged
 * @param {{ includeRuntime?: boolean }} [opts]
 * @returns {WorldData}
 */
export function toWorldData(merged, opts = {}) {
  const { includeRuntime = false } = opts
  const pts = []
  for (const o of merged.objects) {
    if (!includeRuntime && o.id != null && o.id >= RUNTIME_ID_MIN) continue
    pts.push({ gId: o.gId, x: round1(o.x), y: round1(o.y), z: round1(o.z), id: o.id ?? 0 })
  }
  const gids = [...new Set(pts.map((p) => p.gId))].sort(cmpStr)
  const index = new Map(gids.map((g, i) => [g, i]))
  pts.sort((a, b) => cmpStr(a.gId, b.gId) || a.x - b.x || a.z - b.z || a.y - b.y || a.id - b.id)
  const versions = merged.gameVersions ?? []
  return {
    format: WORLD_FORMAT,
    world: merged.planet,
    gameVersion: versions.length === 1 ? versions[0] : null,
    randomizeMineables: merged.randomizeMineables ?? null,
    sources: merged.sources ?? [],
    gids,
    points: pts.map((p) => /** @type {[number, number, number, number, number]} */ (
      [/** @type {number} */ (index.get(p.gId)), p.x, p.y, p.z, p.id])),
  }
}

// ---------------------------------------------------------------------------------------------
// CSV

/**
 * @param {string} src
 * @param {string} where error-message prefix
 */
function parseCsvDump(src, where) {
  const rows = parseCsvRows(src, where)
  if (!rows.length) throw new DumpParseError(`${where}CSV has no header row`)
  const header = rows[0].fields.map((h) => h.toLowerCase())
  /** @type {Record<string, number>} */
  const col = {}
  for (const name of ['gid', 'x', 'y', 'z', 'id', 'planet']) {
    const hits = header.flatMap((h, i) => (h === name ? [i] : []))
    if (hits.length > 1) throw new DumpParseError(`${where}CSV header has column '${name}' ${hits.length} times`)
    if (hits.length) col[name] = hits[0]
  }
  const missing = ['gid', 'x', 'y', 'z'].filter((n) => col[n] === undefined)
  if (missing.length) {
    throw new DumpParseError(`${where}CSV header must contain gId,x,y,z (missing: ${missing.join(', ')}; ` +
      `found: ${rows[0].fields.join(', ')})`)
  }
  const cell = (/** @type {string[]} */ f, /** @type {string} */ name) => (col[name] === undefined ? '' : f[col[name]] ?? '')
  const planets = new Set()
  const objects = rows.slice(1).map(({ fields, line }) => {
    const p = cell(fields, 'planet')
    if (p) planets.add(p)
    const idText = cell(fields, 'id')
    const xyz = ['x', 'y', 'z'].map((n) => cell(fields, n))
    const nums = xyz.map(parseNumber)
    return {
      id: idText === '' ? null : Number.isNaN(parseNumber(idText)) ? idText : parseNumber(idText),
      gId: cell(fields, 'gid'),
      pos: nums.every(Number.isFinite) ? nums : xyz.join(','),
      line,
    }
  })
  if (planets.size > 1) {
    throw new DumpParseError(`${where}CSV rows name ${planets.size} planets (${[...planets].join(', ')}); ` +
      'use one file per planet')
  }
  return { format: DUMP_FORMAT, planet: [...planets][0], gameVersion: null, randomizeMineables: null, source: null, objects }
}

/**
 * RFC 4180-style reader: comma separated, `"` quoting with `""` escapes, quoted fields may hold commas
 * and line breaks, CR / LF / CRLF line endings. Fields are trimmed; blank lines are skipped.
 * @param {string} text
 * @param {string} where
 * @returns {{ line: number, fields: string[] }[]}
 */
function parseCsvRows(text, where) {
  /** @type {{ line: number, fields: string[] }[]} */
  const rows = []
  /** @type {string[]} */
  let fields = []
  let field = ''
  let inQuotes = false
  let line = 1
  let rowLine = 1
  let quoteLine = 0
  const endField = () => {
    fields.push(field.trim())
    field = ''
  }
  const endRow = () => {
    endField()
    if (fields.some((f) => f !== '')) rows.push({ line: rowLine, fields })
    fields = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
        continue
      }
      if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++
      field += ch
    } else if (ch === '"' && field.trim() === '') {
      inQuotes = true
      quoteLine = line
      field = ''
    } else if (ch === ',') {
      endField()
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
      line++
      rowLine = line
    } else {
      field += ch
    }
  }
  if (inQuotes) throw new DumpParseError(`${where}CSV has an unterminated quoted field (opened on line ${quoteLine})`)
  endRow()
  return rows
}

// ---------------------------------------------------------------------------------------------
// helpers

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** Strict decimal number (no hex, no empty string -> 0); NaN when not a number. @param {string} s */
function parseNumber(s) {
  const t = s.trim()
  return NUMBER_RE.test(t) ? Number(t) : NaN
}

/** @param {unknown} pos @returns {number[]|null} */
function readPos(pos) {
  /** @type {unknown[]|null} */
  let parts = null
  if (Array.isArray(pos)) parts = pos
  else if (typeof pos === 'string') parts = pos.split(',').map(parseNumber)
  if (!parts || parts.length !== 3 || !parts.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  return /** @type {number[]} */ (parts)
}

/** Round to 0.1, never producing -0. @param {number} v */
const round1 = (v) => Math.round(v * 10) / 10 || 0

/** Code-unit order: locale-independent, so output is identical on every machine. */
const cmpStr = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0)

/** @param {(string|null)[]} values @returns {string[]} */
const distinct = (values) => [...new Set(values.filter((v) => typeof v === 'string'))].sort(cmpStr)

/** @param {DumpObject} o */
const fmtPos = (o) => `${o.x},${o.y},${o.z}`

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Short, safe rendering of a bad value for error messages. @param {unknown} v */
function show(v) {
  let s
  if (v === undefined) s = 'nothing'
  else if (typeof v === 'number') s = String(v)
  else {
    try {
      s = JSON.stringify(v) ?? String(v)
    } catch {
      s = String(v)
    }
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}
