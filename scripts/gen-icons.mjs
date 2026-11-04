#!/usr/bin/env node
// Renders public/icons/icon.svg to the PNG icons the web manifest and iOS need, using Playwright's
// Chromium (a dev dependency). Run it after editing the SVG and commit the PNGs:
//
//   node scripts/gen-icons.mjs
//
// Outputs (public/icons/):
//   icon-192.png, icon-512.png       "any" purpose, transparent outside the rounded tile
//   icon-maskable-512.png            full-bleed background, mark inside the 80% safe zone
//   apple-touch-icon-180.png         full-bleed background (iOS rounds the corners itself)

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ICONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const BACKGROUND = '#0d1117'

/** @type {{ file: string, size: number, scale: number, fill: string }[]} */
const TARGETS = [
  { file: 'icon-192.png', size: 192, scale: 1, fill: 'transparent' },
  { file: 'icon-512.png', size: 512, scale: 1, fill: 'transparent' },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.8, fill: BACKGROUND },
  { file: 'apple-touch-icon-180.png', size: 180, scale: 1, fill: BACKGROUND },
]

const svg = await readFile(path.join(ICONS, 'icon.svg'), 'utf8')
const browser = await chromium.launch()
try {
  for (const t of TARGETS) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 })
    const inner = Math.round(t.size * t.scale)
    await page.setContent(`<!doctype html><html><head><style>
      html, body { margin: 0; width: ${t.size}px; height: ${t.size}px; overflow: hidden; background: ${t.fill}; }
      body { display: grid; place-items: center; }
      svg { width: ${inner}px; height: ${inner}px; display: block; }
    </style></head><body>${svg}</body></html>`)
    await page.screenshot({ path: path.join(ICONS, t.file), omitBackground: t.fill === 'transparent' })
    await page.close()
    console.log(`wrote public/icons/${t.file} (${t.size}x${t.size})`)
  }
} finally {
  await browser.close()
}
