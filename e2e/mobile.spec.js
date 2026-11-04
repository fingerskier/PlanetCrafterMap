import { expect, test } from '@playwright/test'
import { fixtureDump, importFile, openApp, syntheticSave, trackErrors } from './helpers.js'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })

/** @param {import('@playwright/test').Page} page */
const horizontalOverflow = (page) => page.evaluate(() => {
  const el = document.scrollingElement ?? document.documentElement
  return el.scrollWidth - window.innerWidth
})

test('phone viewport: no horizontal scroll, and the panel collapses and expands', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  const panel = page.locator('#panel')
  const box = await panel.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)

  const toggle = page.getByTestId('panel-toggle')
  const select = page.getByTestId('world-select')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(select).toBeVisible()

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(select).toBeHidden()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(select).toBeVisible()

  // Long imported text (summary lines, file names, category lists) must wrap, not widen the page.
  await importFile(page, syntheticSave())
  await importFile(page, fixtureDump('valid/Prime/01-dumper.json'))
  await expect(page.getByTestId('dump-list')).toBeAttached()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  expect(errors).toEqual([])
})
