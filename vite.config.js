import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Vite's `base` must start and end with '/'. CI passes the GitHub Pages path (e.g. "/PlanetCrafterMap"
 * from actions/configure-pages); a custom domain gives "" or "/".
 * @param {string|undefined} raw
 */
export function normalizeBase(raw) {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

const THEME = '#0d1117'

export default defineConfig({
  base: normalizeBase(process.env.BASE_PATH),
  build: {
    target: 'es2022',
    // Leaflet alone is ~150 kB; one chunk is fine for this app.
    chunkSizeWarningLimit: 1024,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script',
      // The icons already match workbox.globPatterns; listing them twice only duplicates precache entries.
      includeManifestIcons: false,
      manifest: {
        name: 'Planet Crafter Map',
        short_name: 'PC Map',
        description: 'Fan-made, data-generated interactive maps of The Planet Crafter worlds. Works offline.',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        background_color: THEME,
        theme_color: THEME,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // The plugin adds manifest.webmanifest itself; globbing it too duplicates the precache entry.
        globPatterns: ['**/*.{js,css,html,svg,png,json}'],
        // Relief images are large; each is cached the first time its world is shown instead of on install.
        // Their names carry a content hash, so a cached copy never goes stale.
        globIgnores: ['**/data/basemaps/**'],
        runtimeCaching: [{
          urlPattern: ({ url }) => /\/data\/basemaps\/[^/]+\.png$/.test(url.pathname),
          handler: 'CacheFirst',
          options: { cacheName: 'pcmap-basemaps', expiration: { maxEntries: 12 } },
        }],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // registerType 'autoUpdate' only sets these when injectRegister is 'auto'; with 'script' they must be
        // explicit, or a new worker waits forever and the first visit is not controlled until a reload.
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  test: {
    // tools/** holds the dumper's consistency test; e2e/ is Playwright's (npm run test:e2e).
    include: ['test/**/*.test.js', 'tools/**/*.test.js'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
})
