import { expect, test } from '@playwright/test'
import { WORLD_SLUGS, coveredFrameCorners, freeMapPoints, openApp, trackErrors } from './helpers.js'

/**
 * Map X/Z under a viewport point, formatted like the cursor readout.
 * @param {import('@playwright/test').Page} page
 * @param {{ x: number, y: number }} p
 */
const readoutAt = (page, p) => page.evaluate(({ x, y }) => {
  const map = /** @type {any} */ (window).__pcmap.map
  const r = map.getContainer().getBoundingClientRect()
  const ll = map.containerPointToLatLng([x - r.left, y - r.top])
  return `X ${Math.round(ll.lng) || 0} · Z ${Math.round(ll.lat) || 0}`
}, p)

test('boots under the subpath without errors, lists every world and shows the empty state', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)

  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/PlanetCrafterMap\/(#.*)?$/)
  await expect(page.locator('#fatal')).toBeHidden()

  const options = page.getByTestId('world-select').locator('option')
  await expect(options).toHaveCount(WORLD_SLUGS.length)
  expect(await options.evaluateAll((os) => os.map((o) => /** @type {HTMLOptionElement} */ (o).value))).toEqual(WORLD_SLUGS)

  // The repo publishes no points yet, so the empty-state card explains how to get data.
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await expect(page.getByTestId('point-count')).toHaveText('0')
  // The world frame is fitted beside the panel and above the card, not underneath them.
  expect(await coveredFrameCorners(page)).toEqual([])
  // index.json and the world files come from one build: no "Map updated" notice.
  await expect(page.getByTestId('update-notice')).toBeEmpty()

  expect(errors).toEqual([])
})

test('the coordinate readout follows the mouse', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)
  const coords = page.getByTestId('coords')

  const points = await freeMapPoints(page)
  const a = points[0]
  const b = points.find((p) => Math.abs(p.x - a.x) + Math.abs(p.y - a.y) >= 150) ?? points[points.length - 1]

  await page.mouse.move(a.x, a.y)
  const textA = await readoutAt(page, a)
  await expect(coords).toContainText(textA)

  await page.mouse.move(b.x, b.y)
  const textB = await readoutAt(page, b)
  expect(textB).not.toBe(textA)
  await expect(coords).toContainText(textB)

  expect(errors).toEqual([])
})

test('the empty-state card can be dismissed', async ({ page }) => {
  await openApp(page)
  await page.getByTestId('empty-state-dismiss').click()
  await expect(page.getByTestId('empty-state')).toBeHidden()
})
