// Heightmaps (pcmap-heights/1) and the shaded-relief basemap rendered from them. Pure: no DOM and no
// Node APIs (decompression and PNG encoding live in scripts/), so it runs in Node and the browser alike.
//
// A heightmap is a regular X/Z grid of ground heights sampled in the game by tools/dumper. The relief is
// computed from those numbers only: no game textures are involved. Format: docs/ARCHITECTURE.md.

export const HEIGHTS_FORMAT = 'pcmap-heights/1'
export const NODATA = -32768
const CHANNELS = ['terrain', 'surface']
const MAX_CELLS = 50_000_000

/**
 * @typedef {object} HeightsHeader
 * @property {string} format
 * @property {string} planet
 * @property {string|null} gameVersion
 * @property {string} source
 * @property {number} minX x of column 0's cell centre
 * @property {number} minZ z of row 0's cell centre
 * @property {number} step cell spacing, in world units (metres)
 * @property {number} width
 * @property {number} height
 * @property {number} scale metres per stored unit
 * @property {number} nodata
 * @property {string[]} channels
 *
 * @typedef {{ header: HeightsHeader, channels: Record<string, Int16Array> }} Heights
 *
 * @typedef {object} Grid metres, NaN = no sample; row 0 at minZ (south), column 0 at minX (west)
 * @property {number} minX cell centre of column 0
 * @property {number} minZ cell centre of row 0
 * @property {number} step
 * @property {number} width
 * @property {number} height
 * @property {Float32Array} values
 */

/**
 * Decode the decompressed bytes of a pcmap-heights/1 file: a JSON header line, then the channels.
 * @param {Uint8Array} bytes
 * @returns {Heights}
 */
export function decodeHeights(bytes) {
  const nl = bytes.indexOf(0x0a)
  if (nl < 0 || nl > 64 * 1024) throw new Error('no header line')
  /** @type {any} */
  let header
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)))
  } catch (e) {
    throw new Error(`header is not JSON (${/** @type {Error} */ (e).message})`)
  }
  const problem = checkHeader(header)
  if (problem) throw new Error(problem)
  const n = header.width * header.height
  const body = bytes.subarray(nl + 1)
  if (body.length !== n * 2 * header.channels.length) {
    throw new Error(`expected ${n * 2 * header.channels.length} data bytes for ${header.width}x${header.height}x` +
      `${header.channels.length}, got ${body.length}`)
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  /** @type {Record<string, Int16Array>} */
  const channels = {}
  header.channels.forEach((/** @type {string} */ name, /** @type {number} */ c) => {
    const out = new Int16Array(n)
    const base = c * n * 2
    for (let i = 0; i < n; i++) out[i] = view.getInt16(base + 2 * i, true)
    channels[name] = out
  })
  return { header, channels }
}

/** @param {any} h @returns {string|null} */
function checkHeader(h) {
  if (!h || typeof h !== 'object') return 'header must be an object'
  if (h.format !== HEIGHTS_FORMAT) return `format must be ${HEIGHTS_FORMAT} (got ${JSON.stringify(h.format)})`
  if (typeof h.planet !== 'string' || !h.planet) return 'planet must be a non-empty string'
  for (const k of ['minX', 'minZ', 'step', 'scale']) {
    if (typeof h[k] !== 'number' || !Number.isFinite(h[k])) return `${k} must be a finite number`
  }
  if (!(h.step > 0) || !(h.scale > 0)) return 'step and scale must be > 0'
  for (const k of ['width', 'height']) {
    if (!Number.isInteger(h[k]) || h[k] < 2) return `${k} must be an integer >= 2`
  }
  if (h.width * h.height > MAX_CELLS) return `grid is larger than ${MAX_CELLS} cells`
  if (h.nodata !== NODATA) return `nodata must be ${NODATA}`
  if (!Array.isArray(h.channels) || !h.channels.length || h.channels.some((/** @type {unknown} */ c) => typeof c !== 'string') ||
    new Set(h.channels).size !== h.channels.length) return 'channels must be distinct strings'
  if (!h.channels.some((/** @type {string} */ c) => CHANNELS.includes(c))) return `channels must include one of ${CHANNELS.join(', ')}`
  return null
}

/**
 * The ground to draw: the downward-ray surface (cliffs and rocks included) where there is one, else the terrain.
 * @param {Heights} h
 * @returns {Grid}
 */
export function groundGrid({ header, channels }) {
  const n = header.width * header.height
  const values = new Float32Array(n)
  const { surface, terrain } = channels
  for (let i = 0; i < n; i++) {
    const s = surface ? surface[i] : NODATA
    const t = terrain ? terrain[i] : NODATA
    const v = s !== NODATA ? s : t
    values[i] = v === NODATA ? NaN : v * header.scale
  }
  return { minX: header.minX, minZ: header.minZ, step: header.step, width: header.width, height: header.height, values }
}

/**
 * Keep the cells whose centres fall inside [minX, minZ, maxX, maxZ].
 * @param {Grid} g
 * @param {[number, number, number, number]} frame
 * @returns {Grid}
 */
export function cropGrid(g, [fx0, fz0, fx1, fz1]) {
  const c0 = Math.max(0, Math.ceil((fx0 - g.minX) / g.step))
  const c1 = Math.min(g.width - 1, Math.floor((fx1 - g.minX) / g.step))
  const r0 = Math.max(0, Math.ceil((fz0 - g.minZ) / g.step))
  const r1 = Math.min(g.height - 1, Math.floor((fz1 - g.minZ) / g.step))
  const width = c1 - c0 + 1
  const height = r1 - r0 + 1
  if (width < 2 || height < 2) throw new Error('the frame does not overlap the heightmap')
  const values = new Float32Array(width * height)
  for (let r = 0; r < height; r++) {
    values.set(g.values.subarray((r0 + r) * g.width + c0, (r0 + r) * g.width + c1 + 1), r * width)
  }
  return { minX: g.minX + c0 * g.step, minZ: g.minZ + r0 * g.step, step: g.step, width, height, values }
}

/**
 * Average f x f blocks (ignoring missing samples); a partial last block is dropped.
 * @param {Grid} g
 * @param {number} f integer >= 1
 * @returns {Grid}
 */
export function downsample(g, f) {
  if (f <= 1) return g
  const width = Math.floor(g.width / f)
  const height = Math.floor(g.height / f)
  const values = new Float32Array(width * height)
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      let sum = 0
      let n = 0
      for (let dr = 0; dr < f; dr++) {
        const row = (r * f + dr) * g.width + c * f
        for (let dc = 0; dc < f; dc++) {
          const v = g.values[row + dc]
          if (!Number.isNaN(v)) {
            sum += v
            n++
          }
        }
      }
      values[r * width + c] = n ? sum / n : NaN
    }
  }
  // The new cell centre is the mean of the block's old centres.
  const shift = ((f - 1) / 2) * g.step
  return { minX: g.minX + shift, minZ: g.minZ + shift, step: g.step * f, width, height, values }
}

/**
 * Image bounds of a grid, [minX, minZ, maxX, maxZ]: cells are pixels, centred on their sample.
 * @param {Grid} g
 * @returns {[number, number, number, number]}
 */
export function gridBounds(g) {
  const h = g.step / 2
  return [g.minX - h, g.minZ - h, g.minX + (g.width - 1) * g.step + h, g.minZ + (g.height - 1) * g.step + h]
}

/** Low to high: deep basin, lowland, upland, highland, peak. Muted so the coloured points stay readable. */
export const RELIEF_STOPS = /** @type {const} */ ([
  [0.0, [32, 46, 58]],
  [0.3, [46, 62, 60]],
  [0.55, [72, 76, 64]],
  [0.8, [98, 90, 76]],
  [1.0, [138, 134, 126]],
])

/**
 * @param {number} t 0..1
 * @returns {[number, number, number]}
 */
export function tint(t) {
  const s = RELIEF_STOPS
  if (!(t > 0)) return [...s[0][1]]
  if (t >= 1) return [...s[s.length - 1][1]]
  let i = 1
  while (s[i][0] < t) i++
  const [t0, c0] = s[i - 1]
  const [t1, c1] = s[i]
  const k = (t - t0) / (t1 - t0)
  return [0, 1, 2].map((j) => c0[j] + (c1[j] - c0[j]) * k)
}

/**
 * The p-quantile of the finite values (sampled for speed), for a robust height range.
 * @param {Float32Array} values
 * @param {number[]} ps
 */
export function quantiles(values, ps) {
  const stride = Math.max(1, Math.floor(values.length / 200_000))
  const sample = []
  for (let i = 0; i < values.length; i += stride) if (!Number.isNaN(values[i])) sample.push(values[i])
  if (!sample.length) return ps.map(() => NaN)
  sample.sort((a, b) => a - b)
  return ps.map((p) => sample[Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))))])
}

/**
 * Render a grid as RGBA pixels, row 0 = north (top). Hillshade (Horn's method, light from the north-west at
 * 45°) times a height tint; missing samples are transparent.
 * @param {Grid} g
 * @param {{ exaggeration?: number }} [opts]
 * @returns {{ width: number, height: number, rgba: Uint8Array, range: [number, number] }}
 */
export function renderRelief(g, { exaggeration = 1.5 } = {}) {
  const { width: w, height: h, values: v, step } = g
  const [lo, hi] = quantiles(v, [0.01, 0.99])
  const span = hi - lo || 1
  const az = (315 * Math.PI) / 180 // clockwise from north
  const alt = (45 * Math.PI) / 180
  const lx = Math.sin(az) * Math.cos(alt)
  const ly = Math.cos(az) * Math.cos(alt)
  const lz = Math.sin(alt)
  const rgba = new Uint8Array(w * h * 4)
  /** @param {number} c @param {number} r @param {number} fallback */
  const at = (c, r, fallback) => {
    const cc = Math.min(w - 1, Math.max(0, c))
    const rr = Math.min(h - 1, Math.max(0, r))
    const x = v[rr * w + cc]
    return Number.isNaN(x) ? fallback : x
  }
  for (let r = 0; r < h; r++) {
    const out = (h - 1 - r) * w * 4 // flip: grid row 0 is south, image row 0 is north
    for (let c = 0; c < w; c++) {
      const z = v[r * w + c]
      const o = out + c * 4
      if (Number.isNaN(z)) continue // alpha 0
      // Neighbours: a..i, with north = r + 1.
      const a = at(c - 1, r + 1, z), b = at(c, r + 1, z), cN = at(c + 1, r + 1, z)
      const d = at(c - 1, r, z), f = at(c + 1, r, z)
      const gS = at(c - 1, r - 1, z), hS = at(c, r - 1, z), i = at(c + 1, r - 1, z)
      const dzdx = ((cN + 2 * f + i) - (a + 2 * d + gS)) / (8 * step) * exaggeration
      const dzdy = ((a + 2 * b + cN) - (gS + 2 * hS + i)) / (8 * step) * exaggeration // +y = north
      // Normal (-dz/dx, -dz/dy, 1) dotted with the unit vector towards the light (east, north, up).
      const shade = Math.max(0, (-dzdx * lx - dzdy * ly + lz) / Math.sqrt(1 + dzdx * dzdx + dzdy * dzdy))
      const [tr, tg, tb] = tint((z - lo) / span)
      const k = 0.35 + 0.85 * shade
      rgba[o] = clamp8(tr * k)
      rgba[o + 1] = clamp8(tg * k)
      rgba[o + 2] = clamp8(tb * k)
      rgba[o + 3] = 255
    }
  }
  return { width: w, height: h, rgba, range: [lo, hi] }
}

/** @param {number} x */
const clamp8 = (x) => Math.max(0, Math.min(255, Math.round(x)))
