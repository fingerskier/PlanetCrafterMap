import { expect, test } from '@playwright/test'
import { fixtureDump, importFile, openApp, pointMarkers, trackErrors } from './helpers.js'

// A page whose index.json is older than the world files the worker serves (the first launch after a deploy)
// is simulated by serving index.json with a different rev for Prime. page.route() needs the worker blocked.
test.use({ serviceWorkers: 'block' })

/** @param {import('@playwright/test').Page} page */
async function staleIndexForPrime(page) {
  await page.route('**/data/index.json', async (route) => {
    const res = await route.fetch()
    const index = await res.json()
    index.worlds.find((/** @type {any} */ w) => w.id === 'Prime').rev = 'older-index'
    await route.fulfill({ response: res, json: index })
  })
}

test('an outdated page reloads once into the new version, then only offers a reload', async ({ page }) => {
  const errors = trackErrors(page)
  await staleIndexForPrime(page)
  let loads = 0
  page.on('load', () => loads++)

  await page.goto('./#w=prime', { waitUntil: 'commit' }) // the automatic reload may start before 'load'
  const notice = page.getByTestId('update-notice')
  // The mismatch persists (as a reload that cannot fix it would), so the second load must not reload again.
  await expect(notice).toContainText('Map updated', { timeout: 15_000 })
  await expect(page.locator('html')).toHaveAttribute('data-ready', '1')
  expect(loads).toBe(2)
  await expect(page).toHaveURL(/#w=prime(&|$)/)

  await page.getByTestId('update-dismiss').click()
  await expect(notice).toBeEmpty()
  await page.waitForTimeout(500)
  expect(loads).toBe(2)

  expect(errors).toEqual([])
})

test('with imported files loaded, an outdated page shows a notice instead of reloading', async ({ page }) => {
  const errors = trackErrors(page)
  await staleIndexForPrime(page)
  let loads = 0
  page.on('load', () => loads++)

  await openApp(page, 'w=humble')
  // The dump is for Prime, so the app switches there and meets the newer Prime data.
  await importFile(page, fixtureDump('valid/Prime/01-dumper.json'))
  await expect(page.getByTestId('world-select')).toHaveValue('prime')
  const notice = page.getByTestId('update-notice')
  await expect(notice).toContainText('Reloading clears your imported files')
  await expect(notice.getByTestId('update-reload')).toBeVisible()
  await page.waitForTimeout(500)
  expect(loads).toBe(1)
  expect((await pointMarkers(page)).length).toBe(6)

  // Reload is the user's choice. The reloaded page holds no imports, so it uses its one automatic reload,
  // then (the mismatch persisting) settles on the plain notice.
  await notice.getByTestId('update-reload').click()
  await expect(notice.locator('span')).toHaveText('Map updated.')
  expect(loads).toBe(3)

  expect(errors).toEqual([])
})
