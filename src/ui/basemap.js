// Generated basemap: a canvas GridLayer that draws the world frame and an adaptive coordinate grid.
// No game art. In CRS.Simple at tile zoom k, one world unit is 2^k pixels, lat = z (up) and lng = x.

import L from 'leaflet'

/** [minor, major] grid spacings in world units; the minor step is the smallest one >= MIN_PX apart. */
const STEPS = [[10, 50], [25, 100], [50, 250], [100, 500], [250, 1000], [500, 2500], [1000, 5000],
  [2500, 10000], [5000, 25000], [10000, 50000]]
const MIN_PX = 64
const LABEL_MIN_PX = 220 // labelled intersections are at least this far apart
const LABEL_W = 120 // px reserved for a label to the right of an intersection
const LABEL_H = 16

export const BASEMAP_COLORS = {
  background: '#0a0e13',
  frameFill: '#101823',
  frameStroke: 'rgba(86, 211, 100, 0.55)',
  minor: 'rgba(139, 148, 158, 0.10)',
  major: 'rgba(139, 148, 158, 0.26)',
  axis: 'rgba(88, 166, 255, 0.65)',
  label: 'rgba(201, 209, 217, 0.62)',
}

/**
 * Pick grid spacings for a scale so minor lines are 64-160 px apart.
 * @param {number} pxPerUnit
 * @returns {[number, number]} [minor, major]
 */
export function gridSteps(pxPerUnit) {
  for (const s of STEPS) if (s[0] * pxPerUnit >= MIN_PX) return /** @type {[number, number]} */ (s)
  return /** @type {[number, number]} */ (STEPS[STEPS.length - 1])
}

/**
 * Spacing of labelled intersections: a multiple of the minor step (so labels sit on grid lines) that
 * is at least LABEL_MIN_PX apart.
 * @param {number} minor
 * @param {number} pxPerUnit
 */
export function labelStep(minor, pxPerUnit) {
  for (const k of [1, 2, 4, 5, 10]) if (minor * k * pxPerUnit >= LABEL_MIN_PX) return minor * k
  return minor * 10
}

/**
 * Draw one tile.
 * @param {CanvasRenderingContext2D} ctx already scaled for devicePixelRatio
 * @param {{ x: number, y: number, z: number }} coords tile coordinates
 * @param {number} size tile size in CSS px
 * @param {[number, number, number, number]|null} frame [minX, minZ, maxX, maxZ]
 */
export function drawGridTile(ctx, coords, size, frame) {
  const c = BASEMAP_COLORS
  const s = 2 ** coords.z
  const x0 = (coords.x * size) / s
  const x1 = ((coords.x + 1) * size) / s
  const zTop = (-coords.y * size) / s
  const zBot = (-(coords.y + 1) * size) / s
  const px = (/** @type {number} */ x) => (x - x0) * s
  const py = (/** @type {number} */ z) => (zTop - z) * s
  const crisp = (/** @type {number} */ v) => Math.floor(v) + 0.5

  ctx.fillStyle = c.background
  ctx.fillRect(0, 0, size, size)

  if (frame) {
    const [fx0, fz0, fx1, fz1] = frame
    const left = px(fx0)
    const top = py(fz1)
    const w = (fx1 - fx0) * s
    const hgt = (fz1 - fz0) * s
    ctx.fillStyle = c.frameFill
    ctx.fillRect(left, top, w, hgt)
    ctx.strokeStyle = c.frameStroke
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 4])
    ctx.strokeRect(crisp(left), crisp(top), Math.round(w), Math.round(hgt))
    ctx.setLineDash([])
  }

  const [minor, major] = gridSteps(s)
  /** @param {number} v @param {number} lo @param {number} hi include lo, exclude hi */
  const steps = (v, lo, hi) => {
    const out = []
    for (let g = Math.ceil(lo / v) * v; g < hi; g += v) out.push(g || 0)
    return out
  }
  const xs = steps(minor, x0, x1)
  // z grows upwards; take lines with zBot < z <= zTop, i.e. pixel rows [0, size).
  const zs = steps(minor, -zTop, -zBot).map((v) => -v || 0)

  /** @param {number} g */
  const style = (g) => (g === 0 ? [c.axis, 2] : g % major === 0 ? [c.major, 1] : [c.minor, 1])
  for (const g of xs) {
    const [color, width] = style(g)
    ctx.strokeStyle = /** @type {string} */ (color)
    ctx.lineWidth = /** @type {number} */ (width)
    ctx.beginPath()
    ctx.moveTo(crisp(px(g)), 0)
    ctx.lineTo(crisp(px(g)), size)
    ctx.stroke()
  }
  for (const g of zs) {
    const [color, width] = style(g)
    ctx.strokeStyle = /** @type {string} */ (color)
    ctx.lineWidth = /** @type {number} */ (width)
    ctx.beginPath()
    ctx.moveTo(0, crisp(py(g)))
    ctx.lineTo(size, crisp(py(g)))
    ctx.stroke()
  }

  // Labels at grid intersections, drawn below-right of the crossing. Intersections slightly left of /
  // above this tile are included so a label that spills over a tile edge is completed by the neighbour.
  ctx.fillStyle = c.label
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textBaseline = 'top'
  const step = labelStep(minor, s)
  const lx = steps(step, x0 - LABEL_W / s, x1)
  const lz = steps(step, -(zTop + LABEL_H / s), -zBot).map((v) => -v || 0)
  for (const gx of lx) {
    for (const gz of lz) ctx.fillText(`X ${gx}  Z ${gz}`, px(gx) + 4, py(gz) + 3)
  }
}

/**
 * Leaflet GridLayer that renders {@link drawGridTile}. Options: `frame` ([minX, minZ, maxX, maxZ] or null).
 */
export const GridBasemap = L.GridLayer.extend({
  options: {
    tileSize: 256,
    minZoom: -20,
    maxZoom: 20,
    noWrap: true,
    keepBuffer: 2,
    className: 'pc-basemap',
    frame: null,
  },

  /** @param {{ x: number, y: number, z: number }} coords */
  createTile(coords) {
    const size = this.getTileSize().x
    const tile = /** @type {HTMLCanvasElement} */ (L.DomUtil.create('canvas', 'pc-basemap-tile'))
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3)
    tile.width = Math.round(size * dpr)
    tile.height = Math.round(size * dpr)
    const ctx = tile.getContext('2d')
    if (ctx) {
      ctx.scale(dpr, dpr)
      drawGridTile(ctx, coords, size, this.options.frame)
    }
    return tile
  },
})
