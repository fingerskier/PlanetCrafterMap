// Shared e2e helpers. Inputs are synthetic: test/fixtures/save-builder.js and test/fixtures/dumps.

import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import { mergeDumps, parseDumpText, toWorldData, validateDump } from '../src/lib/dump.js'
import { buildSaveText, FAKE_PRIME } from '../test/fixtures/save-builder.js'

/** @typedef {import('@playwright/test').Page} Page */

export const WORLD_SLUGS = ['prime', 'humble', 'selenea', 'aqualis', 'toxicity', 'skeo']

const FIXTURES = new URL('../test/fixtures/dumps/', import.meta.url)

/**
 * A fixture dump as a setInputFiles payload.
 * @param {string} rel path under test/fixtures/dumps/, e.g. 'valid/Prime/01-dumper.json'
 */
export function fixtureDump(rel) {
  const name = rel.split('/').pop()
  return { name, mimeType: rel.endsWith('.csv') ? 'text/csv' : 'application/json', buffer: readFileSync(new URL(rel, FIXTURES)) }
}

/**
 * Serve a fixture dump as Prime's PUBLISHED data (index.json + prime.json), run through the same pipeline
 * functions as scripts/build-data.mjs. The e2e build publishes no points (playwright.config.js builds from an empty dumps folder), so this is the only way to
 * exercise the published layers. Needs `serviceWorkers: 'block'`: page.route() cannot see requests the
 * service worker answers.
 * @param {Page} page
 * @param {string} rel path under test/fixtures/dumps/
 * @returns {Promise<{ gids: string[], points: number[][] }>} the served pcmap-world/1 data
 */
export async function publishAsPrime(page, rel) {
  const raw = parseDumpText(readFileSync(new URL(rel, FIXTURES), 'utf8'), rel)
  const { dump, errors } = validateDump(raw, { defaultPlanet: 'Prime' })
  if (!dump) throw new Error(errors.join('; '))
  const world = { ...toWorldData(mergeDumps([dump])), rev: 'e2e-synthetic' }
  await page.route('**/data/index.json', async (route) => {
    const res = await route.fetch()
    const index = await res.json()
    const prime = index.worlds.find((/** @type {any} */ w) => w.id === 'Prime')
    Object.assign(prime, { count: world.points.length, rev: world.rev })
    await route.fulfill({ response: res, json: index })
  })
  await page.route('**/data/prime.json', (route) => route.fulfill({ json: world }))
  return world
}

/**
 * The scene id that syntheticSave() marks collected. It is the Cobalt object of
 * test/fixtures/dumps/valid/Prime/01-dumper.json, so the hide-collected toggle has something to act on.
 */
export const COLLECTED_ID = 100000002

/**
 * A synthetic save on Prime: the builder's default player ("Test Pilot" at 10.5, 20.25, -30.75), one
 * player-built object, one scene object with saved state, one procedural wreck site and one bare
 * scene record (= collected).
 */
export function syntheticSave() {
  const text = buildSaveText({
    sections: {
      worldObjects: [
        { id: COLLECTED_ID, gId: 'Cobalt' },
        { id: 200000001, gId: 'FakeFoundation', pos: '40,5,60', rot: '0,0,0,1', planet: FAKE_PRIME },
        { id: 100000777, gId: 'FakeCrate', liId: 100000777, pos: '-40,2,-60', planet: FAKE_PRIME },
      ],
      instances: [{ owner: 0, seed: 4242, index: 1, pos: '800,40,-600', planet: FAKE_PRIME, woIdsGenerated: '' }],
    },
  })
  return { name: 'Synthetic_Save.json', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') }
}

/**
 * Collect console errors and uncaught page errors for the page's lifetime.
 * @param {Page} page
 * @returns {string[]}
 */
export function trackErrors(page) {
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()} (${msg.location().url})`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

/**
 * Open the app (relative to baseURL, so the subpath is kept) and wait for the first world render.
 * @param {Page} page
 * @param {string} [hash] e.g. 'w=humble'
 */
export async function openApp(page, hash = '') {
  await page.goto(hash ? `./#${hash}` : './')
  await waitReady(page)
}

/** @param {Page} page */
export async function waitReady(page) {
  await expect(page.locator('html')).toHaveAttribute('data-ready', '1')
  await expect(page.locator('html')).not.toHaveAttribute('data-error', '1')
}

/**
 * `window.__pcmap.getState()`: { world, x, z, zoom, layers, pin? }.
 * @param {Page} page
 */
export const getState = (page) => page.evaluate(() => /** @type {any} */ (window).__pcmap.getState())

/**
 * Point markers (published or dump) currently on the map.
 * @param {Page} page
 * @returns {Promise<{ gId: string, id: number, opacity: number }[]>}
 */
export function pointMarkers(page) {
  return page.evaluate(() => {
    const map = /** @type {any} */ (window).__pcmap.map
    const out = []
    map.eachLayer((/** @type {any} */ l) => {
      if (l.pcPoint) out.push({ gId: l.pcPoint.gId, id: l.pcPoint.id, opacity: l.options.opacity })
    })
    return out
  })
}

/**
 * Choose a file for the import input.
 * @param {Page} page
 * @param {{ name: string, mimeType: string, buffer: Buffer }} file
 */
export async function importFile(page, file) {
  await page.getByTestId('import').setInputFiles(file)
}

/**
 * Viewport points over bare map (no panel, card, control or marker icon on top), for mouse tests.
 * @param {Page} page
 * @returns {Promise<{ x: number, y: number }[]>} on a coarse grid, right to left, top to bottom
 */
export async function freeMapPoints(page) {
  const points = await page.evaluate(() => {
    const out = []
    const map = document.getElementById('map')
    if (!map) return out
    const r = map.getBoundingClientRect()
    for (let fy = 0.15; fy < 0.9; fy += 0.1) {
      for (let fx = 0.9; fx > 0.1; fx -= 0.05) {
        const x = Math.round(r.left + r.width * fx)
        const y = Math.round(r.top + r.height * fy)
        const el = document.elementFromPoint(x, y)
        if (el && map.contains(el) && !el.closest('.leaflet-control, .leaflet-marker-icon, .leaflet-popup')) out.push({ x, y })
      }
    }
    return out
  })
  if (points.length < 2) throw new Error('not enough uncovered map points')
  return points
}

/**
 * Corners and centre of the current world's frame that an overlay (panel, card) hides, after the
 * initial fit. Empty when the whole frame lies on visible map.
 * @param {Page} page
 * @returns {Promise<string[]>} e.g. ['min-min under panel']
 */
export function coveredFrameCorners(page) {
  return page.evaluate(() => {
    const { map, index, getState } = /** @type {any} */ (window).__pcmap
    const world = index.worlds.find((/** @type {any} */ w) => w.slug === getState().world)
    const [minX, minZ, maxX, maxZ] = world.frame
    const box = map.getContainer().getBoundingClientRect()
    /** @type {[string, number, number][]} */
    const probes = [['min-min', minX, minZ], ['min-max', minX, maxZ], ['max-min', maxX, minZ], ['max-max', maxX, maxZ],
      ['centre', (minX + maxX) / 2, (minZ + maxZ) / 2]]
    const out = []
    for (const [name, x, z] of probes) {
      const p = map.latLngToContainerPoint([z, x])
      const el = document.elementFromPoint(box.left + p.x, box.top + p.y)
      if (!el || !map.getContainer().contains(el)) out.push(`${name} under ${el ? el.closest('[id]')?.id ?? el.tagName : 'nothing'}`)
    }
    return out
  })
}

/**
 * Whether two viewport rectangles overlap.
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 */
export const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
