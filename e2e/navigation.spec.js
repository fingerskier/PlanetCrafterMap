import { expect, test } from '@playwright/test'
import { getState, openApp, trackErrors, waitReady } from './helpers.js'

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
