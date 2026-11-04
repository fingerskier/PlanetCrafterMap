import { expect, test } from '@playwright/test'
import { buildSaveText } from '../test/fixtures/save-builder.js'
import {
  COLLECTED_ID, fixtureDump, getState, importFile, openApp, pointMarkers, publishAsPrime, syntheticSave, trackErrors,
  waitReady,
} from './helpers.js'

// test/fixtures/dumps/valid/Prime/01-dumper.json: 8 records -> 6 objects after the duplicate id and the
// in-space sentinel are dropped. An imported dump keeps the runtime-id crate; the published pipeline drops it.
const DUMP = 'valid/Prime/01-dumper.json'
const DUMP_COUNTS = { iron: 1, cobalt: 1, 'golden-effigy': 1, 'storage-crate': 1, 'fish-eggs': 1, other: 1 }
const PUBLISHED_COUNTS = { iron: 1, cobalt: 1, 'golden-effigy': 1, 'fish-eggs': 1, other: 1 }

/** @param {import('@playwright/test').Page} page */
const markerGids = async (page) => (await pointMarkers(page)).map((m) => m.gId).sort()

test('importing a dump draws it by category, and category toggles hide its markers', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=humble')
  await importFile(page, fixtureDump(DUMP))

  // The dump is for Prime, so the map switches there.
  await expect(page.getByTestId('world-select')).toHaveValue('prime')
  await expect(page.getByTestId('dump-list')).toBeVisible()
  await expect(page.getByTestId('dump-list').locator('input[type=checkbox]')).toHaveCount(Object.keys(DUMP_COUNTS).length)
  for (const [id, n] of Object.entries(DUMP_COUNTS)) {
    await expect(page.getByTestId(`dump-cat-${id}`)).toHaveAttribute('data-count', String(n))
  }
  await expect(page.getByTestId('overlay-summary')).toContainText('6 objects')
  await expect.poll(() => pointMarkers(page).then((m) => m.length)).toBe(6)
  await expect(page.getByTestId('empty-state')).toBeHidden()
  // point-count is the published points only; a dump is local data with its own counts.
  await expect(page.getByTestId('point-count')).toHaveText('0')

  await page.getByTestId('dump-cat-iron').uncheck()
  await expect.poll(() => markerGids(page)).toEqual(['Cobalt', 'Container1', 'FakeGizmo', 'Fish3Eggs', 'GoldenEffigie1'])

  const ore = page.getByTestId('dump-cat-group-toggle-ore')
  await expect(ore).toHaveText('All')
  await ore.click()
  await expect(ore).toHaveText('None')
  await expect.poll(() => pointMarkers(page).then((m) => m.length)).toBe(6)
  await ore.click()
  await expect(ore).toHaveText('All')
  await expect.poll(() => markerGids(page)).toEqual(['Container1', 'FakeGizmo', 'Fish3Eggs', 'GoldenEffigie1'])

  await page.getByTestId('clear-overlay').click()
  await expect.poll(() => pointMarkers(page).then((m) => m.length)).toBe(0)
  await expect(page.getByTestId('dump-list')).toBeHidden()
  await expect(page.getByTestId('empty-state')).toBeVisible()

  expect(errors).toEqual([])
})

test('importing a save shows its players and objects; hide-collected hides what it collected', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=humble')
  await importFile(page, syntheticSave())

  // Nothing from the save is on Humble, so the map switches to the save's start planet.
  await expect(page.getByTestId('world-select')).toHaveValue('prime')
  const summary = page.getByTestId('overlay-summary')
  await expect(summary.locator('.line')).not.toHaveCount(0)
  await expect(summary).toContainText(/\b1 player\b/)
  await expect(summary).toContainText(/\b2 placed objects\b/)
  await expect(summary).toContainText(/\b1 wreck site\b/)
  await expect(summary).toContainText(/\b1 collected scene object\b/)

  for (const [key, n] of Object.entries({ players: 1, built: 1, scene: 1, instances: 1 })) {
    await expect(page.getByTestId(`save-${key}`)).toHaveAttribute('data-count', String(n))
  }
  await expect(page.getByTestId('save-wreck')).toHaveCount(0)
  await expect(page.getByTestId('save-unknown')).toHaveCount(0)

  const player = page.locator('#map .pc-player')
  await expect(player).toHaveCount(1)
  await expect(player).toBeVisible()
  // The player marker is a keyboard button: Enter opens its popup.
  await player.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('popup')).toContainText('Player: Test Pilot')
  await page.evaluate(() => /** @type {any} */ (window).__pcmap.map.closePopup())
  await page.getByTestId('save-players').uncheck()
  await expect(player).toHaveCount(0)
  await page.getByTestId('save-players').check()
  await expect(player).toHaveCount(1)

  // A dump holding the scene id the save shows as collected: dimmed, then hidden.
  await importFile(page, fixtureDump(DUMP))
  await expect.poll(() => pointMarkers(page).then((m) => m.length)).toBe(6)
  const markers = await pointMarkers(page)
  const collected = markers.find((m) => m.id === COLLECTED_ID)
  const other = markers.find((m) => m.gId === 'Iron')
  expect(collected && other && collected.opacity < other.opacity).toBe(true)

  await page.getByTestId('hide-collected').check()
  await expect.poll(() => pointMarkers(page).then((m) => m.map((x) => x.id))).not.toContain(COLLECTED_ID)
  expect((await pointMarkers(page)).length).toBe(5)
  await page.getByTestId('hide-collected').uncheck()
  await expect.poll(() => pointMarkers(page).then((m) => m.length)).toBe(6)
  // The save is still loaded next to the dump.
  await expect(player).toHaveCount(1)

  expect(errors).toEqual([])
})

test('a save whose start planet is an Object.prototype key imports instead of crashing', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=humble')
  const meta = { saveDisplayName: 'Proto', planetId: 'constructor', version: '9.999', mode: 'Standard', worldSeed: 1 }
  const text = buildSaveText({ sections: { meta: [meta] } })
  await importFile(page, { name: 'Proto.json', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') })

  await expect(page.getByTestId('overlay-summary')).toContainText('starting on constructor')
  await expect(page.getByTestId('import-error')).toBeHidden()
  await expect(page.getByTestId('world-select')).toHaveValue('humble')

  expect(errors).toEqual([])
})

test('an unreadable file shows an inline error and the app keeps working', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page)
  const importError = page.getByTestId('import-error')

  await importFile(page, fixtureDump('bad/Prime/broken.json'))
  await expect(importError).toBeVisible()
  await expect(importError).toContainText('broken.json')

  await importFile(page, { name: 'noise.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x40]) })
  await expect(importError).toBeVisible()
  await expect(importError).toContainText('noise.bin')

  await expect(page.locator('html')).not.toHaveAttribute('data-error', '1')
  await expect(page.locator('#fatal')).toBeHidden()

  // A good file afterwards clears the error and imports normally.
  await importFile(page, fixtureDump(DUMP))
  await expect(importError).toBeHidden()
  await expect.poll(() => pointMarkers(page).then((m) => m.length)).toBe(6)

  expect(errors).toEqual([])
})

test.describe('published layers (synthetic data served in place of the empty real files)', () => {
  test.use({ serviceWorkers: 'block' })

  test('point-count and category counts follow toggles, the hash and hide-collected', async ({ page }) => {
    const errors = trackErrors(page)
    const world = await publishAsPrime(page, DUMP)
    expect(world.points.length).toBe(5)
    await openApp(page, 'w=prime')

    const count = page.getByTestId('point-count')
    await expect(count).toHaveText('5')
    await expect(page.getByTestId('empty-state')).toBeHidden()
    await expect(page.getByTestId('category-list').locator('input[type=checkbox]')).toHaveCount(Object.keys(PUBLISHED_COUNTS).length)
    for (const [id, n] of Object.entries(PUBLISHED_COUNTS)) {
      await expect(page.getByTestId(`cat-${id}`)).toHaveAttribute('data-count', String(n))
    }
    await expect.poll(() => pointMarkers(page).then((m) => m.length)).toBe(5)

    // Disabled layers go into the hash and come back from it.
    await page.getByTestId('cat-iron').uncheck()
    await expect(count).toHaveText('4')
    await expect.poll(() => markerGids(page)).toEqual(['Cobalt', 'FakeGizmo', 'Fish3Eggs', 'GoldenEffigie1'])
    await expect(page).toHaveURL(/[#&]l=/)
    expect((await getState(page)).layers).not.toContain('iron')
    await page.reload()
    await waitReady(page)
    await expect(page.getByTestId('cat-iron')).not.toBeChecked()
    await expect(count).toHaveText('4')

    const ore = page.getByTestId('cat-group-toggle-ore')
    await expect(ore).toHaveText('All')
    await ore.click()
    await expect(ore).toHaveText('None')
    await expect(count).toHaveText('5')

    // The save marks the published Cobalt point collected: dimmed (still counted), then hidden.
    await importFile(page, syntheticSave())
    await expect(page.getByTestId('overlay-summary')).toContainText(/\b1 match published points\b/)
    await expect(count).toHaveText('5')
    const cobalt = world.points.find((p) => p[4] === COLLECTED_ID)
    if (!cobalt) throw new Error('fixture lost its collected id')
    const at = await page.evaluate(([x, z]) => {
      const map = /** @type {any} */ (window).__pcmap.map
      map.setView([z, x], 1, { animate: false })
      const p = map.latLngToContainerPoint([z, x])
      const r = map.getContainer().getBoundingClientRect()
      return { x: r.left + p.x, y: r.top + p.y }
    }, [cobalt[1], cobalt[3]])
    await page.mouse.click(at.x, at.y)
    const popup = page.getByTestId('popup')
    await expect(popup).toBeVisible()
    await expect(popup.getByTestId('collected-badge')).toBeVisible()
    await expect(popup).toContainText('110:10:-200')

    await page.getByTestId('hide-collected').check()
    await expect(count).toHaveText('4')
    await expect.poll(() => pointMarkers(page).then((m) => m.map((x) => x.id))).not.toContain(COLLECTED_ID)

    expect(errors).toEqual([])
  })
})
