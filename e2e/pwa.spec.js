import { expect, test } from '@playwright/test'
import { WORLD_SLUGS, getState, openApp, trackErrors, waitReady } from './helpers.js'

const BASE = '/PlanetCrafterMap/'

test('the web app manifest is linked, valid and scoped to the subpath', async ({ page, request }) => {
  await openApp(page)
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const url = new URL(/** @type {string} */ (href), page.url())
  expect(url.pathname.startsWith(BASE)).toBe(true)

  const res = await request.get(url.href)
  expect(res.ok()).toBe(true)
  const manifest = await res.json()
  expect(manifest).toMatchObject({ name: expect.any(String), short_name: expect.any(String), display: 'standalone' })
  expect(new URL(manifest.start_url, url).pathname).toBe(BASE)
  expect(new URL(manifest.scope, url).pathname).toBe(BASE)

  const sizes = manifest.icons.map((/** @type {any} */ i) => i.sizes)
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))
  for (const icon of manifest.icons) {
    const r = await request.get(new URL(icon.src, url).href)
    expect(r.ok(), icon.src).toBe(true)
    expect(r.headers()['content-type'], icon.src).toContain(icon.type)
  }
})

test('the service worker controls the page, and the app boots and loads worlds offline', async ({ page, context }) => {
  const errors = trackErrors(page)
  await openApp(page)
  await expect(page.locator('html')).toHaveAttribute('data-sw', 'ready', { timeout: 20_000 })

  // The worker calls skipWaiting() + clients.claim(), so it controls this first page without a reload.
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 10_000 }).toBe(true)
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(new URL(scope).pathname).toBe(BASE)

  // The precache holds the app shell and every data file (keys carry a revision query; compare paths).
  const cached = await page.evaluate(async () => {
    const out = []
    for (const key of await caches.keys()) {
      for (const req of await (await caches.open(key)).keys()) out.push(new URL(req.url).pathname)
    }
    return out
  })
  const files = await page.evaluate(() => /** @type {any} */ (window).__pcmap.index.worlds.map((/** @type {any} */ w) => w.file))
  for (const p of ['index.html', 'data/index.json', ...files.map((/** @type {string} */ f) => `data/${f}`)]) {
    expect(cached, p).toContain(`${BASE}${p}`)
  }

  await context.setOffline(true)
  // The emulation really cuts the network: an uncached URL fails (and logs its own console error).
  const PROBE = 'e2e-not-cached-'
  const probe = await page.evaluate((p) => fetch(`./${p}${Date.now()}.json`).then(() => 'online', () => 'offline'), PROBE)
  expect(probe).toBe('offline')

  await page.reload()
  await waitReady(page)
  await expect(page.locator('#fatal')).toBeHidden()
  await expect(page.getByTestId('world-select').locator('option')).toHaveCount(WORLD_SLUGS.length)

  // A world not opened before loads from the precache too.
  const meta = page.locator('#world-meta')
  await page.getByTestId('world-select').selectOption('aqualis')
  await expect.poll(async () => (await getState(page)).world).toBe('aqualis')
  await expect(meta).not.toHaveText(/Loading|Could not load/)
  await expect(meta).not.toHaveClass(/\berror\b/)

  await context.setOffline(false)
  expect(errors.filter((e) => !e.includes(PROBE))).toEqual([])
})
