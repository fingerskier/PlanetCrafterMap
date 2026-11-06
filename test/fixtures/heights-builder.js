// Synthetic pcmap-heights/1 files for tests. Never put real game heightmaps in test/fixtures.
import { gzipSync } from 'node:zlib'

/**
 * @param {object} o
 * @param {string} [o.planet]
 * @param {number} [o.minX]
 * @param {number} [o.minZ]
 * @param {number} [o.step]
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @param {(x: number, z: number) => number|null} [o.terrain] metres, null = no sample
 * @param {(x: number, z: number) => number|null} [o.surface]
 * @param {object} [o.headerPatch] merged over the header
 * @param {boolean} [o.gzip]
 * @returns {Buffer}
 */
export function buildHeights({
  planet = 'Prime', minX = -100, minZ = -100, step = 10, width = 21, height = 21,
  terrain = (x, z) => (x + z) / 10, surface = () => null, headerPatch = {}, gzip = true,
} = {}) {
  const header = {
    format: 'pcmap-heights/1', planet, gameVersion: '0.0-test', source: 'heights-builder', minX, minZ, step, width,
    height, scale: 0.1, nodata: -32768, channels: ['terrain', 'surface'], ...headerPatch,
  }
  const n = width * height
  const body = Buffer.alloc(n * 4)
  ;[terrain, surface].forEach((fn, c) => {
    for (let r = 0; r < height; r++) {
      for (let col = 0; col < width; col++) {
        const v = fn(minX + col * step, minZ + r * step)
        body.writeInt16LE(v == null ? -32768 : Math.round(v * 10), (c * n + r * width + col) * 2)
      }
    }
  })
  const raw = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), body])
  return gzip ? gzipSync(raw) : raw
}
