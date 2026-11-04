import { expect, test } from '@playwright/test'
import { getState, openApp, overlaps, trackErrors, waitReady } from './helpers.js'

/** @param {Awaited<ReturnType<typeof getState>>} s */
const view = (s) => ({ world: s.world, x: s.x, z: s.z, zoom: s.zoom })

test('switching worlds updates the hash, and the view survives a reload', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)

  await page.getByTestId('world-select').selectOption('toxicity')
  await expect(page).toHaveURL(/#(.*&)?w=toxicity(&|$)/)
  await expect(page).toHaveURL(/[#&]zm=/)
  await expect.poll(async () => (await getState(page)).world).toBe('toxicity')
  const before = view(await getState(page))

  await page.reload()
  await waitReady(page)
  await expect(page.getByTestId('world-select')).toHaveValue('toxicity')
  expect(view(await getState(page))).toEqual(before)

  expect(errors).toEqual([])
})

test('a deep link opens that world and view; a bare URL then restores the last view', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=skeo&x=-1200&z=3000&zm=-1')
  await expect(page.getByTestId('world-select')).toHaveValue('skeo')
  expect(view(await getState(page))).toEqual({ world: 'skeo', x: -1200, z: 3000, zoom: -1 })

  await page.goto('./')
  await waitReady(page)
  await expect(page.getByTestId('world-select')).toHaveValue('skeo')
  await expect(page).toHaveURL(/[#&]w=skeo(&|$)/)

  expect(errors).toEqual([])
})

test('goto pans to the position, drops a pin and puts it in the hash', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)
  const goto = page.getByTestId('goto')

  await goto.fill('somewhere nice')
  await goto.press('Enter')
  await expect(page.getByTestId('goto-error')).toBeVisible()
  await expect(page.locator('.pc-pin')).toHaveCount(0)

  await goto.fill('100:20:-300')
  await goto.press('Enter')
  await expect(page.getByTestId('goto-error')).toBeHidden()
  await expect(page.locator('.pc-pin')).toBeVisible()
  await expect.poll(() => getState(page)).toMatchObject({ x: 100, z: -300, pin: { x: 100, z: -300 } })
  await expect(page).toHaveURL(/[#&]p=100,-300(&|$)/)
  await expect(page.getByTestId('coords')).toContainText('100:20:-300')
  await expect(page.getByTestId('pin-clear')).toBeVisible()

  // The pin is part of the shareable state.
  await page.reload()
  await waitReady(page)
  await expect(page.locator('.pc-pin')).toBeVisible()
  expect((await getState(page)).pin).toEqual({ x: 100, z: -300 })

  await page.getByTestId('pin-clear').click()
  await expect(page.locator('.pc-pin')).toHaveCount(0)
  await expect(page).not.toHaveURL(/[#&]p=/)

  expect(errors).toEqual([])
})

test('a link to a far position on the open world is honoured, not clamped to the current bounds', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=prime')

  await page.evaluate(() => { location.hash = '#w=prime&x=9000&z=9000&zm=0&p=9000,9000' })
  await expect.poll(() => getState(page)).toMatchObject({ world: 'prime', x: 9000, z: 9000, zoom: 0, pin: { x: 9000, z: 9000 } })
  await page.evaluate(() => { location.hash = '#w=prime&x=-8000&z=-8000&zm=0' })
  await expect.poll(() => getState(page)).toMatchObject({ x: -8000, z: -8000, zoom: 0 })
  // Still there once bounds and the hash have settled.
  await page.waitForTimeout(500)
  expect(await getState(page)).toMatchObject({ x: -8000, z: -8000 })
  await expect(page).toHaveURL(/#w=prime&x=-8000&z=-8000&zm=0$/)

  expect(errors).toEqual([])
})

test('the pin opens its popup from the keyboard, clear of the panel', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=prime&p=100,-300')
  const pin = page.locator('.pc-pin')
  const popup = page.getByTestId('popup')

  await pin.focus()
  await page.keyboard.press('Enter')
  await expect(popup).toBeVisible()
  await expect(popup).toContainText('Pinned location')
  await page.evaluate(() => /** @type {any} */ (window).__pcmap.map.closePopup())
  await expect(popup).toHaveCount(0)
  await pin.focus()
  await page.keyboard.press(' ')
  await expect(popup).toBeVisible()
  await page.evaluate(() => /** @type {any} */ (window).__pcmap.map.closePopup())
  await expect(popup).toHaveCount(0) // closed popups fade out before they leave the DOM

  // Put the pin just right of the panel (zoomed in, so the view stays inside maxBounds): a popup centred
  // on it would open half under the panel.
  const pinAt = await page.evaluate(() => {
    const map = /** @type {any} */ (window).__pcmap.map
    map.setView([-300, 100], 0, { animate: false })
    const panel = /** @type {HTMLElement} */ (document.getElementById('panel')).getBoundingClientRect()
    const box = map.getContainer().getBoundingClientRect()
    const at = map.latLngToContainerPoint([-300, 100])
    map.panBy([at.x - (panel.right - box.left + 40), at.y - box.height / 2], { animate: false })
    return map.latLngToContainerPoint([-300, 100]).x + box.left - panel.right
  })
  expect(pinAt).toBeCloseTo(40, 0)
  await pin.click()
  await expect(popup).toBeVisible()
  const panel = await page.locator('#panel').boundingBox()
  await expect.poll(async () => {
    const b = await page.locator('.leaflet-popup').boundingBox()
    return Boolean(b && panel && !overlaps(b, panel))
  }).toBe(true)
  await page.getByTestId('popup-copy').click({ trial: true }) // reachable, not covered

  expect(errors).toEqual([])
})

test.describe('slow world data', () => {
  test.use({ serviceWorkers: 'block' })

  test('going back to the open world while another one loads cancels that load', async ({ page }) => {
    const errors = trackErrors(page)
    for (const file of ['humble', 'selenea']) {
      await page.route(`**/data/${file}.json`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await route.continue().catch(() => {})
      })
    }
    await openApp(page, 'w=prime')
    const select = page.getByTestId('world-select')
    const meta = page.locator('#world-meta')

    // Picking another world, then the open one again before the first arrives.
    const humble = page.waitForResponse('**/data/humble.json')
    await select.selectOption('humble')
    await expect(meta).toHaveText('Loading…')
    await select.selectOption('prime')
    await humble
    await page.waitForTimeout(300)
    expect((await getState(page)).world).toBe('prime')
    await expect(select).toHaveValue('prime')
    await expect(meta).not.toHaveText(/Loading/)
    await expect(page).toHaveURL(/#w=prime(&|$)/)

    // A link to another world, then Back before it arrives: Back wins.
    const selenea = page.waitForResponse('**/data/selenea.json')
    await page.evaluate(() => { location.hash = '#w=selenea' })
    await expect(meta).toHaveText('Loading…')
    await page.goBack()
    await selenea
    await page.waitForTimeout(300)
    expect((await getState(page)).world).toBe('prime')
    await expect(select).toHaveValue('prime')
    await expect(page).toHaveURL(/#w=prime(&|$)/)

    expect(errors).toEqual([])
  })
})
