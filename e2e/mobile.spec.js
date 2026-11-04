import { expect, test } from '@playwright/test'
import { coveredFrameCorners, fixtureDump, getState, importFile, openApp, syntheticSave, trackErrors } from './helpers.js'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })

/** @param {import('@playwright/test').Page} page */
const horizontalOverflow = (page) => page.evaluate(() => {
  const el = document.scrollingElement ?? document.documentElement
  return el.scrollWidth - window.innerWidth
})

test('phone viewport: no horizontal scroll, and the panel starts collapsed and expands', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  const panel = page.locator('#panel')
  const box = await panel.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)

  // Collapsed on first load, so the panel and the empty-state card do not hide most of the map, and the
  // world frame is fitted into the map they leave free.
  const toggle = page.getByTestId('panel-toggle')
  const select = page.getByTestId('world-select')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(select).toBeHidden()
  await expect(page.getByTestId('empty-state')).toBeVisible()
  expect(await coveredFrameCorners(page)).toEqual([])

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(select).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(select).toBeHidden()

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // Long imported text (summary lines, file names, category lists) must wrap, not widen the page.
  await importFile(page, syntheticSave())
  await importFile(page, fixtureDump('valid/Prime/01-dumper.json'))
  await expect(page.getByTestId('dump-list')).toBeAttached()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  expect(errors).toEqual([])
})

test('picking a world on a phone fits its frame clear of the card, without moving focus', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)
  const toggle = page.getByTestId('panel-toggle')
  const select = page.getByTestId('world-select')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // The select lives in the panel, so it is open whenever the world changes. The frame is fitted to the
  // area free once the panel is closed; the panel and focus stay put, so arrow keys keep working.
  await select.focus()
  await select.selectOption('humble')
  await expect.poll(async () => (await getState(page)).world).toBe('humble')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(select).toBeFocused()

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('empty-state')).toBeVisible()
  expect(await coveredFrameCorners(page)).toEqual([])

  expect(errors).toEqual([])
})

test('a pin popup is not hidden by the empty-state card while the panel is open', async ({ page }) => {
  const errors = trackErrors(page)
  // The view is centred on the pin, which leaves it under the open panel.
  await openApp(page, 'w=prime&x=100&z=-300&zm=0&p=100,-300')
  const toggle = page.getByTestId('panel-toggle')
  const card = page.getByTestId('empty-state')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(card).toBeVisible()

  // The popup pans out from under the panel, into the band the card covers.
  await page.locator('.pc-pin').focus()
  await page.keyboard.press('Enter')
  const popup = page.getByTestId('popup')
  await expect(popup).toBeVisible()
  for (const button of [popup.getByTestId('popup-copy'), popup.getByRole('button', { name: 'Remove pin' })]) {
    await button.click({ trial: true, timeout: 3000 }) // reachable, not covered
  }

  await page.locator('.leaflet-popup-close-button').click()
  await expect(popup).toHaveCount(0)
  await expect(card).toBeVisible()

  expect(errors).toEqual([])
})

test.describe('phone in landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  test('a short screen also starts collapsed, with the frame clear of the panel and the card', async ({ page }) => {
    await openApp(page)
    await expect(page.getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('empty-state')).toBeVisible()
    expect(await coveredFrameCorners(page)).toEqual([])
  })

  test('controls stay inside the safe area (viewport-fit=cover, notch on the left)', async ({ page }) => {
    const insets = { top: 0, right: 0, bottom: 21, left: 47 }
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets })
    await openApp(page)
    const width = 844
    const height = 390

    const panel = await page.locator('#panel').boundingBox()
    const coords = await page.getByTestId('coords').boundingBox()
    const zoom = await page.locator('.leaflet-control-zoom').boundingBox()
    const attribution = await page.locator('.leaflet-control-attribution').boundingBox()
    const card = await page.getByTestId('empty-state').boundingBox()
    for (const [name, b] of Object.entries({ panel, coords, zoom, attribution, card })) {
      if (!b) throw new Error(`${name} has no box`)
      expect(b.x, `${name} left`).toBeGreaterThanOrEqual(insets.left)
      expect(b.x + b.width, `${name} right`).toBeLessThanOrEqual(width - insets.right)
      expect(b.y + b.height, `${name} bottom`).toBeLessThanOrEqual(height - insets.bottom)
    }
  })
})
