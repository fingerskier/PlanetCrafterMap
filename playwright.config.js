// Playwright e2e config. The tests run against the PRODUCTION build (service worker included), served
// under the same kind of subpath GitHub Pages uses, so base-path and offline bugs show up here.
// The build goes to its own directory and is served on its own port: a `npm run preview` left running on
// Vite's default port is never mistaken for it, and dist/ stays a plain `npm run build`.

import { defineConfig, devices } from '@playwright/test'

const PORT = 4317
const OUT_DIR = 'dist-e2e'
const BASE_PATH = '/PlanetCrafterMap/'
const CI = Boolean(process.env.CI)

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/build-data.mjs --dumps test/fixtures/dumps/empty --heights test/fixtures/heights/empty --quiet && npx vite build --outDir ${OUT_DIR} && npx vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${BASE_PATH}`,
    env: { BASE_PATH },
    // Always build the code under test; a server already on the port fails the run instead of being reused.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
