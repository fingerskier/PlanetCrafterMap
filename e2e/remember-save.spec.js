import { expect, test } from '@playwright/test'
import { buildSaveText, FAKE_PRIME } from '../test/fixtures/save-builder.js'
import { importFile, openApp, syntheticSave, trackErrors, waitReady } from './helpers.js'

/** A save on Prime with `n` placed objects, as text. */
const saveWithObjects = (/** @type {number} */ n) => buildSaveText({
  sections: {
    worldObjects: Array.from({ length: n }, (_, i) =>
      ({ id: 200000001 + i, gId: 'FakeFoundation', pos: `${40 + i},5,60`, rot: '0,0,0,1', planet: FAKE_PRIME })),
  },
})

test('an imported save is remembered across reloads until it is cleared', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=humble')
  await importFile(page, syntheticSave())
  const summary = page.getByTestId('overlay-summary')
  await expect(summary).toContainText('Synthetic_Save.json')
  await expect(page.getByTestId('world-select')).toHaveValue('prime')

  // The store write is asynchronous; reload once it has landed.
  await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('pcmap')
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('kv')) return resolve(false)
      const get = db.transaction('kv').objectStore('kv').get('save')
      get.onsuccess = () => resolve(Boolean(get.result))
    }
  }))).toBe(true)

  await page.reload()
  await waitReady(page)
  await expect(summary).toContainText('Synthetic_Save.json')
  await expect(summary).toContainText(/\b1 player\b/)
  await expect(page.locator('#map .pc-player')).toHaveCount(1)
  // Restoring keeps the world in the URL rather than jumping to the save's start planet.
  await expect(page.getByTestId('world-select')).toHaveValue('prime')
  // Picked with a plain file input: no handle, so the button re-imports.
  await expect(page.getByTestId('refresh-save')).toHaveText('Re-import save…')

  await page.getByTestId('clear-overlay').click()
  await expect(summary).toBeHidden()
  await page.reload()
  await waitReady(page)
  await expect(page.locator('#overlay-box')).toBeHidden()
  await expect(page.locator('#map .pc-player')).toHaveCount(0)

  expect(errors).toEqual([])
})

test('a save picked with a file handle refreshes from its file', async ({ page }) => {
  const errors = trackErrors(page)
  // A stand-in for the File System Access API whose file the test can rewrite, as the game would.
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window)
    w.__fakeSaveText = ''
    const handle = {
      kind: 'file',
      name: 'Standard-1.json',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFile: async () => {
        if (w.__fakeDelay) await new Promise((r) => setTimeout(r, w.__fakeDelay))
        return new File([w.__fakeSaveText], 'Standard-1.json', { type: 'application/json' })
      },
    }
    w.showOpenFilePicker = async () => [handle]
  })
  await openApp(page, 'w=prime')
  await page.evaluate((t) => { /** @type {any} */ (window).__fakeSaveText = t }, saveWithObjects(1))

  await page.locator('label[for="import"]').click()
  const summary = page.getByTestId('overlay-summary')
  await expect(summary).toContainText('Standard-1.json')
  await expect(summary).toContainText(/\b1 placed object\b/)
  const refresh = page.getByTestId('refresh-save')
  await expect(refresh).toHaveText('Refresh save')

  await page.evaluate((t) => { /** @type {any} */ (window).__fakeSaveText = t }, saveWithObjects(3))
  await refresh.click()
  await expect(summary).toContainText(/\b3 placed objects\b/)
  await expect(page.getByTestId('import-error')).toBeHidden()

  // Clearing while a refresh is still reading the file wins: the late read neither shows nor stores it.
  await page.evaluate(() => { /** @type {any} */ (window).__fakeDelay = 300 })
  await refresh.click()
  await page.getByTestId('clear-overlay').click()
  await page.waitForTimeout(600)
  await expect(page.locator('#overlay-box')).toBeHidden()
  await page.reload()
  await waitReady(page)
  await expect(page.locator('#overlay-box')).toBeHidden()

  expect(errors).toEqual([])
})

test('a remembered save that no longer parses is forgotten with a message', async ({ page }) => {
  const errors = trackErrors(page)
  await openApp(page, 'w=prime')
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('pcmap', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => {
      const t = req.result.transaction('kv', 'readwrite')
      t.objectStore('kv').put({ name: 'Broken.json', bytes: new TextEncoder().encode('not a save').buffer, savedAt: 1, handle: null }, 'save')
      t.oncomplete = resolve
      t.onerror = () => reject(t.error)
    }
  }))
  await page.reload()
  await waitReady(page)
  await expect(page.getByTestId('import-error')).toContainText('Broken.json')
  await expect(page.locator('#overlay-box')).toBeHidden()
  await page.reload()
  await waitReady(page)
  await expect(page.getByTestId('import-error')).toBeHidden()

  expect(errors).toEqual([])
})
