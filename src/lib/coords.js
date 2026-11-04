// World <-> map coordinate helpers. Pure: no DOM, safe in Node and the browser.
//
// The map plane is the game's X/Z plane (Unity is Y-up): +X east (right), +Z north (up), Y is altitude.
// Leaflet CRS.Simple maps lat to the vertical axis (up) and lng to the horizontal axis (right), so
// lat = z and lng = x. See docs/ARCHITECTURE.md.

/** Coordinates beyond this magnitude are treated as input mistakes (worlds span a few thousand units). */
export const COORD_LIMIT = 1_000_000

/**
 * @typedef {[number, number, number, number]} Frame [minX, minZ, maxX, maxZ]
 * @typedef {[[number, number], [number, number]]} LatLngBoundsTuple [[minZ, minX], [maxZ, maxX]]
 */

/**
 * @param {number} x
 * @param {number} z
 * @returns {[number, number]} Leaflet [lat, lng] = [z, x]
 */
export const toLatLng = (x, z) => [z, x]

/**
 * @param {{ lat: number, lng: number }} latlng
 * @returns {{ x: number, z: number }}
 */
export const fromLatLng = ({ lat, lng }) => ({ x: lng, z: lat })

/**
 * @param {Frame} frame [minX, minZ, maxX, maxZ]
 * @returns {LatLngBoundsTuple} [[minZ, minX], [maxZ, maxX]] (south-west, north-east)
 */
export const frameToBounds = ([minX, minZ, maxX, maxZ]) => [[minZ, minX], [maxZ, maxX]]

// Strict decimal: optional sign, digits with optional fraction (or a bare fraction), optional exponent.
// No hex, no Infinity, and an empty token is not 0.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
// One surrounding pair of brackets or parentheses is allowed, e.g. a pasted `[12.5, 30.1, -40.2]`.
const WRAPPED_RE = /^\[(.*)\]$|^\((.*)\)$/s

/**
 * Parse a coordinate typed or pasted by the user.
 *
 * Accepts three numbers as `X:Y:Z` (the in-game HUD order), or two numbers as `X Z` (no altitude).
 * Separators are any run of whitespace, `,`, `;` or `:`, so "221:12:432", "-865, 88, -419",
 * "x;y;z" and "100 -200" all work. One pair of surrounding `[]` or `()` is ignored.
 * Returns null for anything else (wrong count, non-numbers, hex, non-finite, |v| > COORD_LIMIT).
 * @param {unknown} str
 * @returns {{ x: number, y: number|null, z: number } | null}
 */
export function parseCoordInput(str) {
  if (typeof str !== 'string') return null
  let s = str.trim()
  const wrapped = WRAPPED_RE.exec(s)
  if (wrapped) s = (wrapped[1] ?? wrapped[2]).trim()
  if (!s) return null
  const tokens = s.split(/[\s,;:]+/).filter((t) => t !== '')
  if (tokens.length !== 2 && tokens.length !== 3) return null
  if (!tokens.every((t) => NUMBER_RE.test(t))) return null
  const nums = tokens.map(Number)
  if (!nums.every((n) => Number.isFinite(n) && Math.abs(n) <= COORD_LIMIT)) return null
  const clean = (/** @type {number} */ n) => n || 0 // -0 -> 0
  if (nums.length === 2) return { x: clean(nums[0]), y: null, z: clean(nums[1]) }
  return { x: clean(nums[0]), y: clean(nums[1]), z: clean(nums[2]) }
}

/**
 * Format a position the way the in-game HUD shows it: `X:Y:Z`, rounded to integers.
 * A missing (null / non-finite) component is shown as `?`.
 * @param {number} x
 * @param {number|null} y
 * @param {number} z
 * @returns {string} e.g. "123:45:-678"
 */
export function formatHud(x, y, z) {
  return [x, y, z].map(fmtInt).join(':')
}

/** @param {number|null|undefined} v */
function fmtInt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '?'
  return String(Math.round(v) || 0) // Math.round(-0.4) is -0
}
