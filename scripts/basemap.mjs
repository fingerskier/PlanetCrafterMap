// Node side of the generated basemap: read a pcmap-heights/1 file, render it (src/lib/heights.js), encode a PNG.
// Output is byte-deterministic for the same input.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { crc32, deflateSync, gunzipSync } from 'node:zlib'
import { cropGrid, decodeHeights, downsample, gridBounds, groundGrid, renderRelief } from '../src/lib/heights.js'

/** Longest image side, in pixels. Larger grids are averaged down by an integer factor. */
export const MAX_SIDE = 2048

/**
 * @param {string} abs path of a gzip-compressed pcmap-heights/1 file
 * @returns {Promise<import('../src/lib/heights.js').Heights>}
 */
export async function readHeightsFile(abs) {
  const raw = await readFile(abs)
  let bytes
  try {
    bytes = gunzipSync(raw, { maxOutputLength: 256 * 1024 * 1024 })
  } catch (e) {
    throw new Error(`not a gzip file (${/** @type {Error} */ (e).message})`)
  }
  return decodeHeights(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/**
 * Render a heightmap to a PNG, cropped to `frame` (when given) and scaled to at most MAX_SIDE pixels.
 * @param {import('../src/lib/heights.js').Heights} heights
 * @param {{ frame?: [number, number, number, number]|null, maxSide?: number }} [opts]
 * @returns {{ png: Buffer, hash: string, bounds: [number, number, number, number], width: number, height: number,
 *   step: number, range: [number, number] }}
 */
export function renderBasemap(heights, { frame = null, maxSide = MAX_SIDE } = {}) {
  let grid = groundGrid(heights)
  if (frame) grid = cropGrid(grid, frame)
  const f = Math.max(1, Math.ceil(Math.max(grid.width, grid.height) / maxSide))
  grid = downsample(grid, f)
  if (grid.width < 2 || grid.height < 2) {
    throw new Error(`the cropped heightmap is too thin to draw (${grid.width}x${grid.height} px after scaling by 1/${f})`)
  }
  const img = renderRelief(grid)
  const png = encodePng(img.width, img.height, img.rgba)
  return {
    png,
    hash: createHash('sha256').update(png).digest('hex').slice(0, 12),
    bounds: gridBounds(grid),
    width: img.width,
    height: img.height,
    step: grid.step,
    range: img.range,
  }
}

/**
 * Minimal PNG encoder: 8-bit RGBA, or RGB when every pixel is opaque. Paeth filter on every row.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba width * height * 4 bytes, row 0 = top
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  let opaque = true
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false
      break
    }
  }
  const bpp = opaque ? 3 : 4
  const stride = width * bpp
  const raw = Buffer.alloc((stride + 1) * height)
  let prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const d = x * bpp
      cur[d] = rgba[s]
      cur[d + 1] = rgba[s + 1]
      cur[d + 2] = rgba[s + 2]
      if (bpp === 4) cur[d + 3] = rgba[s + 3]
    }
    const o = y * (stride + 1)
    raw[o] = 4 // Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      raw[o + 1 + i] = (cur[i] - pred) & 0xff
    }
    prev = Uint8Array.from(cur)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = opaque ? 2 : 6 // RGB / RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}
