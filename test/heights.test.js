import { inflateSync, crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodePng, renderBasemap } from '../scripts/basemap.mjs'
import {
  NODATA, cropGrid, decodeHeights, downsample, gridBounds, groundGrid, quantiles, renderRelief, tint, RELIEF_STOPS,
} from '../src/lib/heights.js'
import { buildHeights } from './fixtures/heights-builder.js'

const decode = (opts) => decodeHeights(new Uint8Array(buildHeights({ ...opts, gzip: false })))

/** @param {Buffer} png */
function readPng(png) {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks = []
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o)
    const type = png.toString('latin1', o + 4, o + 8)
    const data = png.subarray(o + 8, o + 8 + len)
    expect(png.readUInt32BE(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)) >>> 0)
    chunks.push({ type, data })
    o += 12 + len
  }
  expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  const ihdr = chunks[0].data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bpp = ihdr[9] === 6 ? 4 : 3
  const raw = inflateSync(chunks[1].data)
  const stride = width * bpp
  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    expect(filter).toBe(4)
    const cur = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      const p = a + b - c
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      cur[i] = (raw[y * (stride + 1) + 1 + i] + pred) & 0xff
    }
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) out[(y * width + x) * 4 + k] = cur[x * bpp + k]
      out[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255
    }
    prev = cur
  }
  return { width, height, colorType: ihdr[9], rgba: out }
}

describe('decodeHeights', () => {
  it('reads the header and both channels', () => {
    const h = decode({ width: 3, height: 2, minX: 0, minZ: 0, step: 1, terrain: (x, z) => x + 10 * z, surface: (x) => (x === 1 ? null : 5) })
    expect(h.header).toMatchObject({ planet: 'Prime', width: 3, height: 2, step: 1 })
    expect([...h.channels.terrain]).toEqual([0, 10, 20, 100, 110, 120])
    expect([...h.channels.surface]).toEqual([50, NODATA, 50, 50, NODATA, 50])
  })

  it('rejects malformed files', () => {
    expect(() => decodeHeights(new Uint8Array([1, 2, 3]))).toThrow(/no header line/)
    expect(() => decodeHeights(new TextEncoder().encode('nope\n'))).toThrow(/not JSON/)
    expect(() => decode({ headerPatch: { format: 'pcmap-heights/2' } })).toThrow(/format must be/)
    expect(() => decode({ headerPatch: { step: 0 } })).toThrow(/> 0/)
    expect(() => decode({ headerPatch: { width: 1.5 } })).toThrow(/width/)
    expect(() => decode({ headerPatch: { channels: ['other'] } })).toThrow(/channels/)
    const bytes = buildHeights({ gzip: false })
    expect(() => decodeHeights(new Uint8Array(bytes.subarray(0, bytes.length - 2)))).toThrow(/data bytes/)
  })
})

describe('grids', () => {
  it('prefers the surface channel and falls back to the terrain', () => {
    const g = groundGrid(decode({ width: 2, height: 2, minX: 0, minZ: 0, step: 1, terrain: (x) => (x ? null : 1), surface: (x, z) => (z ? 7 : null) }))
    expect([...g.values]).toEqual([1, NaN, 7, 7])
  })

  it('crops to cell centres inside a frame', () => {
    const g = groundGrid(decode({ width: 5, height: 4, minX: 0, minZ: 0, step: 10, terrain: (x, z) => x + z / 10 }))
    const c = cropGrid(g, [5, 5, 30, 25])
    expect(c).toMatchObject({ minX: 10, minZ: 10, width: 3, height: 2 })
    expect([...c.values]).toEqual([11, 21, 31, 12, 22, 32])
    expect(() => cropGrid(g, [1000, 1000, 2000, 2000])).toThrow(/does not overlap/)
  })

  it('averages blocks, skipping missing samples, and keeps bounds aligned', () => {
    const g = groundGrid(decode({ width: 5, height: 4, minX: 0, minZ: 0, step: 10, terrain: (x, z) => (x === 0 && z === 0 ? null : x) }))
    const d = downsample(g, 2)
    expect(d).toMatchObject({ width: 2, height: 2, step: 20, minX: 5, minZ: 5 })
    expect([...d.values].map((v) => +v.toFixed(3))).toEqual([6.667, 25, 5, 25]) // (10 + 0 + 10) / 3: the missing cell is skipped
    expect(gridBounds(g)).toEqual([-5, -5, 45, 35])
    expect(gridBounds(d)).toEqual([-5, -5, 35, 35])
  })

  it('takes robust quantiles', () => {
    const v = Float32Array.from({ length: 101 }, (_, i) => (i === 50 ? NaN : i))
    expect(quantiles(v, [0, 1])).toEqual([0, 100])
    expect(quantiles(new Float32Array([NaN]), [0.5])).toEqual([NaN])
  })
})

describe('renderRelief', () => {
  it('tints low to high and clamps out-of-range heights', () => {
    expect(tint(-1)).toEqual([...RELIEF_STOPS[0][1]])
    expect(tint(2)).toEqual([...RELIEF_STOPS[RELIEF_STOPS.length - 1][1]])
    const mid = tint(0.15)
    expect(mid[0]).toBeGreaterThan(RELIEF_STOPS[0][1][0])
    expect(mid[0]).toBeLessThan(RELIEF_STOPS[1][1][0])
  })

  it('lights slopes facing north-west and shades slopes facing south-east', () => {
    // A ridge along the NE-SW diagonal: its NW face rises towards the south-east.
    const ridge = (x, z) => Math.max(0, 50 - Math.abs(x - z))
    const g = groundGrid(decode({ width: 41, height: 41, minX: -100, minZ: -100, step: 5, terrain: ridge }))
    const img = renderRelief(g)
    const px = (x, z) => {
      const col = (x + 100) / 5
      const row = 40 - (z + 100) / 5 // image row 0 is north
      const o = (row * 41 + col) * 4
      return img.rgba[o] + img.rgba[o + 1] + img.rgba[o + 2]
    }
    // Same height (25), opposite faces: (-20, 5) is on the NW face, (5, -20) on the SE face.
    expect(px(-20, 5)).toBeGreaterThan(px(5, -20) * 1.5)
  })

  it('leaves missing samples transparent and puts north at the top', () => {
    const g = groundGrid(decode({ width: 4, height: 3, minX: 0, minZ: 0, step: 1, terrain: (x, z) => (z === 2 && x === 0 ? null : 1) }))
    const img = renderRelief(g)
    expect(img.rgba[3]).toBe(0) // top-left pixel = north-west cell (z = 2)
    expect(img.rgba[(2 * 4) * 4 + 3]).toBe(255)
  })
})

describe('PNG output', () => {
  it('round-trips RGB and RGBA pixels', () => {
    const rgba = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37) & 0xff))
    const rgb = readPng(encodePng(5, 3, rgba))
    expect(rgb).toMatchObject({ width: 5, height: 3, colorType: 2 })
    expect([...rgb.rgba]).toEqual([...rgba])
    rgba[7] = 0
    const alpha = readPng(encodePng(5, 3, rgba))
    expect(alpha.colorType).toBe(6)
    expect([...alpha.rgba]).toEqual([...rgba])
  })

  it('renders a basemap deterministically, cropped and scaled down', () => {
    const heights = decode({ width: 101, height: 81, minX: -500, minZ: -400, step: 10, terrain: (x, z) => 20 * Math.sin(x / 80) + z / 20 })
    const a = renderBasemap(heights, { frame: [-300, -300, 300, 300], maxSide: 32 })
    const b = renderBasemap(heights, { frame: [-300, -300, 300, 300], maxSide: 32 })
    expect(a.png.equals(b.png)).toBe(true)
    expect(a.hash).toMatch(/^[0-9a-f]{12}$/)
    expect(a).toMatchObject({ width: 30, height: 30, step: 20 })
    expect(a.bounds).toEqual([-305, -305, 295, 295]) // 60 of the 61 cropped cells, pixel edges
    expect(readPng(a.png)).toMatchObject({ width: 30, height: 30 })
  })
})
