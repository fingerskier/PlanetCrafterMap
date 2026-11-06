import { expect, test } from '@playwright/test'
import { encodePng } from '../scripts/basemap.mjs'
import { openApp, trackErrors } from './helpers.js'

// page.route() cannot see requests the service worker answers.
test.use({ serviceWorkers: 'block' })

test('a world with a relief basemap draws it under a transparent grid', async ({ page }) => {
  const errors = trackErrors(page)
  const rgba = new Uint8Array(4 * 4 * 4).fill(200)
  const png = encodePng(4, 4, rgba)
  await page.route('**/data/index.json', async (route) => {
    const res = await route.fetch()
    const index = await res.json()
    const prime = index.worlds.find((/** @type {any} */ w) => w.id === 'Prime')
    prime.basemap = { type: 'image', url: 'data/basemaps/prime-e2e.png', bounds: [-2000, -2000, 3000, 3000] }
    await route.fulfill({ response: res, json: index })
  })
  await page.route('**/data/basemaps/prime-e2e.png', (route) => route.fulfill({ body: png, contentType: 'image/png' }))
  await openApp(page, 'w=prime')

  const img = page.locator('.leaflet-basemapImage-pane img.leaflet-image-layer')
  await expect(img).toHaveCount(1)
  await expect.poll(() => img.evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth)).toBe(4)
  const z = await page.evaluate(() => ['basemapImage', 'tile'].map((p) =>
    Number(getComputedStyle(/** @type {Element} */ (document.querySelector(`.leaflet-${p}-pane`))).zIndex)))
  expect(z[0]).toBeLessThan(z[1])
  // The grid's tiles are transparent where no line is drawn, so the image shows through.
  const clear = await page.locator('.pc-basemap-tile').first().evaluate((el) => {
    const c = /** @type {HTMLCanvasElement} */ (el)
    const d = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] === 0) n++
    return n / (d.length / 4)
  })
  expect(clear).toBeGreaterThan(0.8)

  // A world without one keeps the opaque grid and no image.
  await page.getByTestId('world-select').selectOption('humble')
  await expect(img).toHaveCount(0)
  expect(errors).toEqual([])
})
