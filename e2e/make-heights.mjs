// Writes a synthetic Prime heightmap for the e2e build (playwright.config.js), so the built app has a real
// relief basemap to show and cache. Synthetic only: never real game data.
//   node e2e/make-heights.mjs <dir>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildHeights } from '../test/fixtures/heights-builder.js'

const dir = process.argv[2]
if (!dir) throw new Error('usage: node e2e/make-heights.mjs <dir>')
rmSync(dir, { recursive: true, force: true })
mkdirSync(path.join(dir, 'Prime'), { recursive: true })
const hill = (/** @type {number} */ x, /** @type {number} */ z) => 80 * Math.exp(-((x - 500) ** 2 + (z - 500) ** 2) / 8e5)
writeFileSync(path.join(dir, 'Prime', 'e2e.heights.gz'),
  buildHeights({ minX: -2000, minZ: -2000, step: 25, width: 201, height: 201, terrain: hill }))
