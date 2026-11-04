// URL-hash view state. Pure: no DOM, safe in Node and the browser.
//
// The hash is the single source of truth for what the map shows, so every view is a shareable link.
// It is a hash (not a path or query) because GitHub Pages answers deep paths with 404 and the service
// worker precache is keyed on exact URLs. Format (keys always in this order, each optional):
//
//   #w=<world slug>&x=<center X>&z=<center Z>&zm=<zoom>&l=<category ids, comma separated>&p=<pinX>,<pinZ>
//
// `l` absent means "the default layer set" (the caller decides what that is); `l=` means "no layers".
// Validating the world slug against the index is the caller's job.

import { COORD_LIMIT } from './coords.js'

/**
 * @typedef {object} HashState
 * @property {string} [world] world slug (unvalidated)
 * @property {number} [x] view center X
 * @property {number} [z] view center Z
 * @property {number} [zoom]
 * @property {string[]} [layers] enabled category ids; [] = none; absent = default set
 * @property {{ x: number, z: number }} [pin]
 */

/** Zoom values beyond this magnitude are nonsense for this app (Leaflet would clamp anyway). */
export const ZOOM_LIMIT = 30
const WORLD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
// Same rule as category ids in categories.js: they go into `l` unescaped.
const LAYER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Parse a location hash. Never throws: unknown keys, malformed escapes and invalid values are
 * ignored (each key independently). When a key repeats, the last occurrence wins.
 * @param {unknown} hash e.g. location.hash ('#w=prime&x=10'), with or without the leading '#'
 * @returns {HashState}
 */
export function decodeHash(hash) {
  /** @type {HashState} */
  const out = {}
  if (typeof hash !== 'string') return out
  const body = hash.replace(/^#/, '')
  if (!body) return out
  /** @type {Map<string, string>} */
  const params = new Map()
  for (const part of body.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = safeDecode(part.slice(0, eq))
    const value = safeDecode(part.slice(eq + 1))
    if (key !== null && value !== null) params.set(key, value)
  }

  const w = params.get('w')?.trim()
  if (w && WORLD_RE.test(w)) out.world = w
  const x = coord(params.get('x'))
  if (x !== null) out.x = x
  const z = coord(params.get('z'))
  if (z !== null) out.z = z
  const zm = num(params.get('zm'))
  if (zm !== null && Math.abs(zm) <= ZOOM_LIMIT) out.zoom = zm
  const l = params.get('l')
  if (l !== undefined) out.layers = cleanLayers(l.split(','))
  const p = params.get('p')
  if (p !== undefined) {
    const parts = p.split(',')
    const px = coord(parts[0])
    const pz = coord(parts[1])
    if (parts.length === 2 && px !== null && pz !== null) out.pin = { x: px, z: pz }
  }
  return out
}

/**
 * Serialize view state. Keys come out in the fixed order w, x, z, zm, l, p; missing or invalid values
 * are left out. The center is rounded to whole units, the pin to 0.1 and the zoom to 0.01.
 * `layers: []` gives `l=` (no layers); `layers` undefined leaves `l` out (default set).
 * @param {HashState} state
 * @returns {string} '#w=prime&x=10&z=-20&zm=-1.5&l=iron,cobalt&p=10,-20', or '' when nothing is set
 */
export function encodeHash(state) {
  /** @type {string[]} */
  const parts = []
  const s = state ?? {}
  if (typeof s.world === 'string' && WORLD_RE.test(s.world)) parts.push(`w=${encodeURIComponent(s.world)}`)
  if (isCoord(s.x)) parts.push(`x=${round(s.x, 1)}`)
  if (isCoord(s.z)) parts.push(`z=${round(s.z, 1)}`)
  if (typeof s.zoom === 'number' && Number.isFinite(s.zoom) && Math.abs(s.zoom) <= ZOOM_LIMIT) {
    parts.push(`zm=${round(s.zoom, 100)}`)
  }
  if (Array.isArray(s.layers)) parts.push(`l=${cleanLayers(s.layers).join(',')}`)
  if (s.pin && isCoord(s.pin.x) && isCoord(s.pin.z)) parts.push(`p=${round(s.pin.x, 10)},${round(s.pin.z, 10)}`)
  return parts.length ? `#${parts.join('&')}` : ''
}

/** @param {string} s @returns {string|null} */
function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

/** @param {string|undefined} s @returns {number|null} */
function num(s) {
  if (typeof s !== 'string') return null
  const t = s.trim()
  if (!NUMBER_RE.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n || 0 : null
}

/** @param {string|undefined} s */
function coord(s) {
  const n = num(s)
  return n !== null && Math.abs(n) <= COORD_LIMIT ? n : null
}

/** @param {unknown} v @returns {v is number} */
const isCoord = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT

/** Valid, de-duplicated layer ids in first-seen order. @param {unknown[]} ids */
function cleanLayers(ids) {
  const out = new Set()
  for (const id of ids) {
    const t = typeof id === 'string' ? id.trim() : ''
    if (LAYER_RE.test(t)) out.add(t)
  }
  return [...out]
}

/** Round to 1/scale, never producing -0. @param {number} v @param {number} scale */
const round = (v, scale) => Math.round(v * scale) / scale || 0
