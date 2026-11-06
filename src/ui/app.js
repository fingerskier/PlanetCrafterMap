// The client app: wires the URL-hash state, the Leaflet map, the panel and imports together.
// Hash state (src/lib/state.js) is the single source of truth for world, view, layers and pin.

import L from 'leaflet'
import { compileCategories } from '../lib/categories.js'
import { formatHud, frameToBounds, fromLatLng, parseCoordInput, toLatLng } from '../lib/coords.js'
import { decodeHash, encodeHash } from '../lib/state.js'
import { GridBasemap } from './basemap.js'
import { $, h, plural } from './dom.js'
import { importFile } from './importer.js'
import { CategoryList, renderToggleList } from './panel.js'
import { CategoryLayers, bucketByCategory, worldPoints } from './points.js'
import { onActivate, popupContent } from './popup.js'
import { SAVE_LAYERS, SaveLayers } from './save-layers.js'
import { canPickWithHandle, forgetSave, loadSave, pickWithHandle, rereadHandle, rereadIfGranted, storeSave } from './save-store.js'
import { createUpdateHandler, watchControllerChange } from './update.js'

/**
 * @typedef {import('./points.js').MapPoint} MapPoint
 * @typedef {import('./importer.js').SaveImport} SaveImport
 * @typedef {import('./importer.js').DumpImport} DumpImport
 * @typedef {import('../lib/state.js').HashState} HashState
 * @typedef {{ id: string, slug: string, name: string, kind: string, access: string, hash: number,
 *   frame: [number, number, number, number], extent: [number, number, number, number]|null, count: number,
 *   file: string, rev: string, basemap: { type: string, url: string, bounds: [number, number, number, number] }|null }} IndexWorld
 * @typedef {{ format: string, worlds: IndexWorld[], groups: object[], categories: object[] }} IndexData
 */

const STORAGE_KEY = 'pcmap:lastHash'
const HASH_DELAY = 250
const MAX_WARNINGS = 50
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/
const README = 'https://github.com/fingerskier/PlanetCrafterMap#readme'
/** Screens where the open panel would cover most of the map: it starts collapsed there. */
const COMPACT_MEDIA = '(max-width: 720px), (max-height: 500px)'
/** The fit / popup area skips an overlay whose cut would leave less than this (px) either way. */
const MIN_FREE = 120

/**
 * Start the app. Resolves once the initial hash state is applied (or a fatal error is shown); sets
 * `<html data-ready="1">` after the first world render and exposes `window.__pcmap`.
 * @param {{ baseUrl: string }} opts Vite's BASE_URL ('/' or '/PlanetCrafterMap/')
 */
export async function startApp({ baseUrl }) {
  const root = document.documentElement
  const ui = {
    map: $('#map'),
    panel: $('#panel'),
    panelHead: /** @type {HTMLElement} */ ($('#panel .panel-head')),
    panelBody: $('#panel-body'),
    panelToggle: /** @type {HTMLButtonElement} */ ($('[data-testid="panel-toggle"]')),
    worldSelect: /** @type {HTMLSelectElement} */ ($('[data-testid="world-select"]')),
    worldMeta: $('#world-meta'),
    goto: /** @type {HTMLInputElement} */ ($('[data-testid="goto"]')),
    gotoGo: $('#goto-go'),
    gotoError: $('[data-testid="goto-error"]'),
    pinClear: $('[data-testid="pin-clear"]'),
    search: /** @type {HTMLInputElement} */ ($('[data-testid="search"]')),
    categoryList: $('[data-testid="category-list"]'),
    pointCount: $('[data-testid="point-count"]'),
    importInput: /** @type {HTMLInputElement} */ ($('[data-testid="import"]')),
    importStatus: $('#import-status'),
    importError: $('[data-testid="import-error"]'),
    overlayBox: $('#overlay-box'),
    overlaySummary: $('[data-testid="overlay-summary"]'),
    overlayWarnings: /** @type {HTMLDetailsElement} */ ($('#overlay-warnings')),
    saveSection: $('#save-section'),
    saveLayers: $('#save-layers'),
    dumpSection: $('#dump-section'),
    dumpList: $('[data-testid="dump-list"]'),
    clearOverlay: $('[data-testid="clear-overlay"]'),
    refreshSave: /** @type {HTMLButtonElement} */ ($('[data-testid="refresh-save"]')),
    hideCollected: /** @type {HTMLInputElement} */ ($('[data-testid="hide-collected"]')),
    coordsCursor: $('#coords-cursor'),
    coordsPin: $('#coords-pin'),
    empty: $('[data-testid="empty-state"]'),
    emptyWorld: $('#empty-world'),
    emptyDismiss: $('#empty-dismiss'),
    fatal: $('#fatal'),
    updateNotice: $('#update-notice'),
  }

  /** @param {string} message */
  const fatal = (message) => {
    ui.fatal.replaceChildren(h('h2', null, 'The map could not start'), h('p', null, message),
      h('p', null, h('a', { href: README, target: '_blank', rel: 'noopener' }, 'Project README')))
    ui.fatal.hidden = false
    root.dataset.error = '1'
  }

  /** @param {boolean} open */
  const setPanelOpen = (open) => {
    ui.panel.classList.toggle('collapsed', !open)
    ui.panelBody.hidden = !open
    ui.panelToggle.setAttribute('aria-expanded', String(open))
    ui.panelToggle.title = open ? 'Collapse panel' : 'Expand panel'
  }
  const isCompact = () => Boolean(window.matchMedia?.(COMPACT_MEDIA).matches)
  if (isCompact()) setPanelOpen(false)

  // A worker taking over means a new deploy, except the first claim of a page opened before any worker.
  let holdsImports = () => false
  const outdated = createUpdateHandler({ notice: ui.updateNotice, holdsImports: () => holdsImports() })
  watchControllerChange(navigator.serviceWorker, outdated)

  // A bare URL restores the last view (per browser), so reopening the installed app lands where you were.
  if (!location.hash) {
    const saved = storageGet(STORAGE_KEY)
    if (saved && saved.startsWith('#')) history.replaceState(history.state, '', saved)
  }

  /** @type {IndexData} */
  let index
  /** @type {ReturnType<typeof compileCategories>} */
  let cats
  try {
    index = await fetchJson(`${baseUrl}data/index.json`)
    if (index?.format !== 'pcmap-index/1' || !Array.isArray(index.worlds) || !index.worlds.length) {
      throw new Error('data/index.json is not a pcmap-index/1 file with worlds')
    }
    cats = compileCategories(index)
  } catch (e) {
    fatal(`Could not load the map data (${errorMessage(e)}). If you are offline, open the app once while online.`)
    return
  }
  const worlds = index.worlds
  const worldIds = worlds.map((w) => w.id)
  const allCatIds = cats.categories.map((c) => c.id)

  const app = {
    /** @type {IndexWorld|null} */
    world: null,
    /** @type {{ gameVersion: string|null, error: string|null }} */
    worldInfo: { gameVersion: null, error: null },
    /** @type {MapPoint[]} */
    worldPts: [],
    enabled: new Set(allCatIds),
    /** @type {{ x: number, z: number, y: number|null }|null} */
    pin: null,
    /** @type {SaveImport|null} */
    save: null,
    /** @type {FileSystemFileHandle|null} the save's original file, where the browser can re-read it */
    saveHandle: null,
    /** when the loaded save was read from its file (ms) */
    saveReadAt: 0,
    /** the loaded save is remembered on this device, so a reload keeps it */
    savePersisted: false,
    /** @type {Set<number>} */
    collected: new Set(),
    hideCollected: ui.hideCollected.checked,
    /** @type {Map<string, DumpImport>} world id -> dump */
    dumps: new Map(),
    saveEnabled: new Set(SAVE_LAYERS.map((l) => l.key)),
    dumpEnabled: new Set(allCatIds),
    viewReady: false,
    /** @type {L.LatLngBounds|null} */
    openedView: null,
    loadToken: 0,
    emptyDismissed: false,
    popupOpen: false,
    rendered: false,
  }
  // A remembered save survives a reload; a dump (or a save the browser could not store) does not.
  holdsImports = () => (Boolean(app.save) && !app.savePersisted) || app.dumps.size > 0
  /** @type {Map<string, Promise<{ points: MapPoint[], gameVersion: string|null }>>} */
  const worldCache = new Map()

  // ---- map -------------------------------------------------------------------------------------
  const renderer = L.canvas({ padding: 0.5, tolerance: 5 })
  const map = L.map(ui.map, {
    crs: L.CRS.Simple,
    renderer,
    preferCanvas: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    minZoom: -5,
    maxZoom: 3,
    zoomControl: false,
    attributionControl: true,
  })
  L.control.zoom({ position: 'bottomright' }).addTo(map)
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>')
  map.createPane('basemapImage').style.zIndex = '250'
  /** @type {L.GridLayer|null} */
  let grid = null
  /** @type {L.ImageOverlay|null} */
  let image = null
  /** @type {L.Marker|null} */
  let pinMarker = null

  const marks = () => ({ collected: app.collected, hide: app.hideCollected })
  const published = new CategoryLayers(map, { renderer, categories: cats.byId, marks, popupOptions })
  const dumpLayers = new CategoryLayers(map, { renderer, categories: cats.byId, marks, popupOptions, source: 'Your dump', stroke: '#ffffff' })
  const saveLayers = new SaveLayers(map, renderer, { popupOptions })

  // ---- panel widgets -----------------------------------------------------------------------------
  const catList = new CategoryList(ui.categoryList, {
    prefix: 'cat',
    emptyText: 'No published points for this world yet.',
    onChange: (ids, on) => {
      for (const id of ids) on ? app.enabled.add(id) : app.enabled.delete(id)
      catList.setEnabled(app.enabled)
      published.sync(app.enabled)
      renderPointCount()
      writeHash()
    },
  })
  const dumpList = new CategoryList(ui.dumpList, {
    prefix: 'dump-cat',
    emptyText: 'Your dump has no points on this world.',
    onChange: (ids, on) => {
      for (const id of ids) on ? app.dumpEnabled.add(id) : app.dumpEnabled.delete(id)
      dumpList.setEnabled(app.dumpEnabled)
      dumpLayers.sync(app.dumpEnabled)
    },
  })

  for (const w of worlds) {
    const tag = w.access === 'dlc' ? ' (DLC)' : w.kind === 'moon' ? ' (moon)' : ''
    ui.worldSelect.append(h('option', { value: w.slug }, `${w.name}${tag}`))
  }

  // ---- state <-> hash ---------------------------------------------------------------------------
  /** @param {string|undefined} key */
  const resolveWorld = (key) => {
    if (!key) return worlds[0]
    const k = key.toLowerCase()
    return worlds.find((w) => w.slug === key) ?? worlds.find((w) => w.slug.toLowerCase() === k || w.id.toLowerCase() === k) ?? worlds[0]
  }
  const enabledList = () => allCatIds.filter((id) => app.enabled.has(id))

  /** @returns {HashState} */
  const rawState = () => {
    const c = app.viewReady ? fromLatLng(map.getCenter()) : null
    return {
      world: app.world?.slug,
      x: c?.x,
      z: c?.z,
      zoom: app.viewReady ? map.getZoom() : undefined,
      layers: app.enabled.size === allCatIds.length ? undefined : enabledList(),
      pin: app.pin ? { x: app.pin.x, z: app.pin.z } : undefined,
    }
  }

  /** The state as the URL holds it, with `layers` always explicit. */
  const getState = () => ({ ...decodeHash(encodeHash(rawState())), layers: enabledList() })

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let hashTimer
  const writeHash = () => {
    clearTimeout(hashTimer)
    if (!app.world) return
    const hash = encodeHash(rawState())
    if (hash && hash !== location.hash) history.replaceState(history.state, '', hash)
    storageSet(STORAGE_KEY, hash)
  }
  const scheduleHashWrite = () => {
    clearTimeout(hashTimer)
    hashTimer = setTimeout(writeHash, HASH_DELAY)
  }

  /**
   * Make the page show `s`. World data loads asynchronously; a newer call supersedes an older one.
   * @param {HashState} s
   * @returns {Promise<boolean>} false when superseded
   */
  async function applyState(s) {
    const token = ++app.loadToken
    const world = resolveWorld(s.world)
    app.enabled = s.layers ? new Set(s.layers.filter((id) => cats.byId.has(id))) : new Set(allCatIds)
    const keepY = app.pin && s.pin && app.pin.x === s.pin.x && app.pin.z === s.pin.z ? app.pin.y : null
    app.pin = s.pin ? { x: s.pin.x, z: s.pin.z, y: keepY } : null

    const worldChanged = world !== app.world
    if (worldChanged && !(await loadWorld(world, token))) return false
    if (!worldChanged) {
      // This call may have superseded a load of another world that already showed it as loading.
      ui.worldSelect.value = world.slug
      renderWorldMeta()
    }

    // An explicit position is honoured even outside the current bounds (a link pasted into an open tab).
    const explicit = s.x !== undefined && s.z !== undefined
    if (worldChanged || !app.viewReady || explicit) map.setMaxBounds(/** @type {any} */ (null))
    const frameBounds = L.latLngBounds(frameToBounds(world.frame))
    if (explicit) {
      const zoom = s.zoom ?? (app.viewReady && !worldChanged ? map.getZoom() : map.getBoundsZoom(frameBounds))
      map.setView(toLatLng(s.x, s.z), clampZoom(zoom), { animate: false })
    } else if (worldChanged || !app.viewReady) {
      if (s.zoom !== undefined) map.setView(frameBounds.getCenter(), clampZoom(s.zoom), { animate: false })
      // On a phone the panel is open while the world is picked; fit to what is free once it is closed.
      else map.fitBounds(frameBounds, freeArea([isCompact() ? ui.panelHead : ui.panel, ui.empty]))
    } else if (s.zoom !== undefined) {
      map.setZoom(clampZoom(s.zoom))
    }
    app.viewReady = true
    syncRadius()
    if (worldChanged) renderBasemap()
    // The view a world opens with, or a link asks for, is always reachable, even when it is larger than
    // the padded data bounds (tall phone screens) or lies outside them.
    if (worldChanged || !app.openedView || explicit) app.openedView = map.getBounds()
    updateMaxBounds()

    catList.setEnabled(app.enabled)
    published.sync(app.enabled)
    renderPin()
    renderPointCount()
    if (!app.rendered) {
      app.rendered = true
      showCursor(fromLatLng(map.getCenter()))
      root.dataset.ready = '1'
    }
    return true
  }

  /** @param {number} z */
  const clampZoom = (z) => Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), z))

  /**
   * The part of the map the panel and the empty-state card leave free, as fitBounds padding. Each overlay
   * is cut off the side that keeps the most area: beside the panel on wide screens, below it on phones,
   * above or beside the card. An overlay whose cut would leave less than MIN_FREE either way is ignored.
   * @param {HTMLElement[]} [overlays]
   */
  function freeArea(overlays = [ui.panel, ui.empty]) {
    const m = ui.map.getBoundingClientRect()
    const gap = 16
    let r = { left: m.left + gap, top: m.top + gap, right: m.right - gap, bottom: m.bottom - gap - 24 }
    const width = (/** @type {typeof r} */ c) => c.right - c.left
    const height = (/** @type {typeof r} */ c) => c.bottom - c.top
    for (const el of overlays) {
      if (el.hidden) continue
      const o = el.getBoundingClientRect()
      if (o.right <= r.left || o.left >= r.right || o.bottom <= r.top || o.top >= r.bottom) continue
      const cuts = [{ ...r, left: o.right + gap }, { ...r, right: o.left - gap }, { ...r, top: o.bottom + gap }, { ...r, bottom: o.top - gap }]
        .filter((c) => width(c) >= MIN_FREE && height(c) >= MIN_FREE)
      if (cuts.length) r = cuts.reduce((a, b) => (width(b) * height(b) > width(a) * height(a) ? b : a))
    }
    return {
      paddingTopLeft: L.point(r.left - m.left, r.top - m.top),
      paddingBottomRight: L.point(m.right - r.right, m.bottom - r.bottom),
      animate: false,
    }
  }

  /**
   * Popups pan clear of the panel, which sits above Leaflet's popup pane. The empty-state card does too,
   * but it hides while a popup is open: on a phone with the panel open there is no room beside both.
   */
  function popupOptions() {
    const { paddingTopLeft, paddingBottomRight } = freeArea([ui.panel])
    return { autoPanPaddingTopLeft: paddingTopLeft, autoPanPaddingBottomRight: paddingBottomRight }
  }

  /** Smaller markers when zoomed out. */
  const syncRadius = () => {
    const z = map.getZoom()
    const r = z <= -3.5 ? 2.5 : z < -2 ? 3 : z < 0 ? 4 : 5
    published.setRadius(r)
    dumpLayers.setRadius(r)
  }

  /** @param {HashState} s */
  async function navigate(s) {
    if (await applyState(s)) writeHash()
  }

  // ---- world loading and rendering ----------------------------------------------------------------
  /** @param {IndexWorld} world */
  function fetchWorld(world) {
    let p = worldCache.get(world.slug)
    if (!p) {
      p = (async () => {
        if (!FILE_RE.test(world.file)) throw new Error(`bad data file name ${JSON.stringify(world.file)}`)
        const data = await fetchJson(`${baseUrl}data/${world.file}`)
        if (data?.format !== 'pcmap-world/1' || !Array.isArray(data.gids) || !Array.isArray(data.points)) {
          throw new Error(`${world.file} is not a pcmap-world/1 file`)
        }
        // index.json and every world file of one build share their revs, so a different rev means this
        // page's index is older (or newer) than the data the worker now serves.
        if (typeof data.rev === 'string' && typeof world.rev === 'string' && data.rev !== world.rev) outdated()
        return { points: worldPoints(data), gameVersion: typeof data.gameVersion === 'string' ? data.gameVersion : null }
      })()
      worldCache.set(world.slug, p)
      p.catch(() => worldCache.delete(world.slug))
    }
    return p
  }

  /**
   * @param {IndexWorld} world
   * @param {number} token the calling applyState's; any newer applyState supersedes this load
   * @returns {Promise<boolean>} false when superseded
   */
  async function loadWorld(world, token) {
    ui.worldSelect.value = world.slug
    ui.worldMeta.textContent = 'Loading…'
    /** @type {{ points: MapPoint[], gameVersion: string|null }} */
    let data = { points: [], gameVersion: null }
    let error = null
    try {
      data = await fetchWorld(world)
    } catch (e) {
      error = `Could not load ${world.name} data: ${errorMessage(e)}`
    }
    if (token !== app.loadToken) return false
    map.closePopup()
    app.world = world
    app.worldPts = data.points
    app.worldInfo = { gameVersion: data.gameVersion, error }
    published.setPoints(bucketByCategory(data.points, cats.classify))
    setOverlayWorld()
    renderWorldPanel()
    return true
  }

  /** Point the save / dump layers at the current world's part. */
  function setOverlayWorld() {
    if (!app.world) return
    saveLayers.setWorld(app.save?.overlay.worlds[app.world.id] ?? null)
    saveLayers.sync(app.saveEnabled)
    const dump = app.dumps.get(app.world.id)
    dumpLayers.setPoints(bucketByCategory((dump?.objects ?? []).map((o) => ({ ...o, id: o.id ?? 0 })), cats.classify))
    dumpLayers.sync(app.dumpEnabled)
  }

  function renderBasemap() {
    const world = /** @type {IndexWorld} */ (app.world)
    grid?.remove()
    grid = new GridBasemap({ frame: world.frame })
    grid.addTo(map)
    image?.remove()
    image = null
    if (world.basemap?.type === 'image' && typeof world.basemap.url === 'string') {
      image = L.imageOverlay(`${baseUrl}${world.basemap.url.replace(/^\/+/, '')}`, frameToBounds(world.basemap.bounds), {
        pane: 'basemapImage', interactive: false, alt: '',
      }).addTo(map)
    }
  }

  /** Frame, published extent, this world's imported data and the pin, padded by 50%. */
  function updateMaxBounds() {
    const world = app.world
    if (!world) return
    const b = L.latLngBounds(frameToBounds(world.frame))
    if (world.extent) b.extend(L.latLngBounds(frameToBounds(world.extent)))
    if (world.basemap?.bounds) b.extend(L.latLngBounds(frameToBounds(world.basemap.bounds)))
    const part = app.save?.overlay.worlds[world.id]
    if (part) for (const o of [...part.players, ...part.objects, ...part.instances]) b.extend(toLatLng(o.x, o.z))
    for (const o of app.dumps.get(world.id)?.objects ?? []) b.extend(toLatLng(o.x, o.z))
    if (app.pin) b.extend(toLatLng(app.pin.x, app.pin.z))
    const padded = b.pad(0.5)
    if (app.openedView) padded.extend(app.openedView)
    map.setMaxBounds(padded)
  }

  function renderWorldMeta() {
    const world = /** @type {IndexWorld} */ (app.world)
    const meta = []
    meta.push(world.count ? `${plural(world.count, 'published point')}` : 'No published points yet')
    if (app.worldInfo.gameVersion) meta.push(`game ${app.worldInfo.gameVersion}`)
    const text = app.worldInfo.error ?? meta.join(' · ')
    if (ui.worldMeta.textContent !== text) ui.worldMeta.textContent = text // a live region: no repeats
    ui.worldMeta.classList.toggle('error', Boolean(app.worldInfo.error))
  }

  function renderWorldPanel() {
    renderWorldMeta()
    catList.render({ categories: cats.categories, groups: cats.groups, count: (id) => published.count(id), enabled: app.enabled })
    renderOverlayBox()
    renderPointCount()
  }

  function renderPointCount() {
    ui.pointCount.textContent = String(published.visibleCount(app.enabled))
    renderEmptyState()
  }

  function renderEmptyState() {
    const show = Boolean(app.world) && !app.emptyDismissed && published.total === 0 && saveLayers.total === 0 && dumpLayers.total === 0
    ui.empty.hidden = !show || app.popupOpen // see popupOptions()
    if (app.world) ui.emptyWorld.textContent = app.world.name
  }

  // ---- pin and coordinates ---------------------------------------------------------------------
  function renderPin() {
    pinMarker?.remove()
    pinMarker = null
    ui.pinClear.hidden = !app.pin
    ui.coordsPin.hidden = !app.pin
    if (!app.pin) return
    const { x, y, z } = app.pin
    ui.coordsPin.textContent = y === null ? `Pin X ${Math.round(x)} · Z ${Math.round(z)}` : `Pin ${formatHud(x, y, z)}`
    const icon = L.divIcon({ className: 'pc-pin', iconSize: [22, 22], iconAnchor: [11, 11], html: '<span></span>' })
    pinMarker = L.marker(toLatLng(x, z), { icon, title: 'Pinned location', alt: 'Pinned location', zIndexOffset: 2000, keyboard: true })
    onActivate(pinMarker, () => {
      const content = popupContent({ title: 'Pinned location', color: '#ff4d6d', x, y, z })
      const remove = h('button', { type: 'button', class: 'btn btn-small' }, 'Remove pin')
      remove.addEventListener('click', () => {
        map.closePopup()
        setPin(null)
      })
      content.append(remove)
      L.popup({ maxWidth: 280, offset: L.point(0, -6), ...popupOptions() }).setLatLng(toLatLng(x, z)).setContent(content).openOn(map)
    })
    pinMarker.addTo(map)
  }

  /** @param {{ x: number, z: number, y: number|null }|null} pin */
  function setPin(pin) {
    app.pin = pin
    updateMaxBounds()
    renderPin()
    writeHash()
  }

  let mouseOnMap = false
  /** @param {{ x: number, z: number }} p */
  const showCursor = (p) => {
    ui.coordsCursor.textContent = `X ${Math.round(p.x) || 0} · Z ${Math.round(p.z) || 0}`
  }
  map.on('mousemove', (e) => {
    mouseOnMap = true
    showCursor(fromLatLng(e.latlng))
  })
  map.on('mouseout', () => {
    mouseOnMap = false
    showCursor(fromLatLng(map.getCenter()))
  })
  map.on('move', () => {
    if (!mouseOnMap) showCursor(fromLatLng(map.getCenter()))
  })
  map.on('moveend', scheduleHashWrite)
  map.on('zoomend', syncRadius)
  // Every popup opens with openOn, which closes the previous one first: at most one is open.
  map.on('popupopen popupclose', (e) => {
    app.popupOpen = e.type === 'popupopen'
    renderEmptyState()
  })

  function goto() {
    const raw = ui.goto.value
    const parsed = parseCoordInput(raw)
    if (!parsed) {
      ui.gotoError.textContent = raw.trim()
        ? `"${raw.trim()}" is not a position. Use X:Y:Z (as in the game HUD), X,Y,Z or X Z.`
        : 'Type a position first, e.g. 221:12:432.'
      ui.gotoError.hidden = false
      ui.goto.setAttribute('aria-invalid', 'true')
      return
    }
    ui.gotoError.hidden = true
    ui.goto.removeAttribute('aria-invalid')
    app.pin = parsed
    updateMaxBounds()
    map.setView(toLatLng(parsed.x, parsed.z), Math.max(map.getZoom(), 0))
    renderPin()
    writeHash()
  }

  // ---- imports and overlays --------------------------------------------------------------------
  /**
   * @param {File} file
   * @param {object} [opts]
   * @param {FileSystemFileHandle|null} [opts.handle] the file's handle, kept for "Refresh save"
   * @param {'import'|'refresh'|'restore'} [opts.mode] refresh and restore keep the current world
   * @param {number} [opts.readAt] when the bytes were read from the file (restore: when they were stored)
   */
  async function handleImport(file, { handle = null, mode = 'import', readAt = Date.now() } = {}) {
    ui.importError.hidden = true
    ui.importStatus.textContent = `${mode === 'restore' ? 'Restoring' : 'Reading'} ${file.name}…`
    const result = await importFile(file, { worldIds, defaultPlanet: app.world?.id ?? worldIds[0] })
    ui.importStatus.textContent = ''
    if (result.kind === 'error') {
      ui.importError.replaceChildren(
        h('ul', null, result.errors.slice(0, MAX_WARNINGS).map((m) => h('li', null, m))))
      ui.importError.hidden = false
      return
    }
    /** @type {string|null} world id worth switching to */
    let target = null
    if (result.kind === 'save') {
      app.save = result
      app.saveHandle = handle
      app.saveReadAt = readAt
      app.collected = new Set(result.overlay.collectedSceneIds)
      if (mode === 'restore') {
        app.savePersisted = true
      } else {
        app.savePersisted = false
        const bytes = await file.arrayBuffer()
        // Superseded by a newer import or a clear while the bytes were read: do not store this one.
        if (app.save === result) {
          storeSave({ name: result.name, bytes, handle }).then((ok) => {
            if (app.save === result) app.savePersisted = ok
          })
        }
      }
      const here = app.world ? result.overlay.worlds[app.world.id] : null
      // startPlanet is the save's own string: a key such as 'constructor' must not reach Object.prototype.
      const start = Object.hasOwn(result.overlay.worlds, result.overlay.startPlanet) ? result.overlay.worlds[result.overlay.startPlanet] : null
      const size = (/** @type {any} */ w) => (w ? w.players.length + w.objects.length + w.instances.length : 0)
      if (mode === 'import' && size(here) === 0 && size(start) > 0) target = result.overlay.startPlanet
    } else {
      app.dumps.set(result.planet, result)
      if (result.planet !== app.world?.id) target = result.planet
    }
    const targetWorld = target ? worlds.find((w) => w.id === target) : null
    if (targetWorld && targetWorld !== app.world) {
      await navigate({ world: targetWorld.slug, layers: rawState().layers })
    } else {
      setOverlayWorld()
      updateMaxBounds()
    }
    published.restyle(app.enabled)
    renderOverlayBox()
    renderPointCount()
  }

  function renderOverlayBox() {
    const world = app.world
    const save = app.save
    const dump = world ? app.dumps.get(world.id) : undefined
    const any = Boolean(save) || app.dumps.size > 0
    ui.overlayBox.hidden = !any
    if (!any || !world) return

    /** @type {string[]} */
    const lines = []
    /** @type {string[]} */
    const warnings = []
    if (save) {
      const o = save.overlay
      const c = saveLayers.counts()
      const objects = c.built + c.wreck + c.scene + c.unknown
      lines.push(`Save ${save.name}${o.version ? ` (game ${o.version})` : ''}, starting on ${o.startPlanet}` +
        (app.saveReadAt ? `, read ${formatReadAt(app.saveReadAt)}.` : '.'))
      const parts = [`${c.built} built`, `${c.wreck} wreck`, `${c.scene} scene`]
      if (c.unknown) parts.push(`${c.unknown} other`)
      lines.push(`On ${world.name}: ${plural(c.players, 'player')}, ${plural(objects, 'placed object')} ` +
        `(${parts.join(', ')}), ${plural(c.instances, 'wreck site')}.`)
      let matched = 0
      for (const p of app.worldPts) if (p.id && app.collected.has(p.id)) matched++
      lines.push(`${plural(o.counts.collected, 'collected scene object')} in the save; ` +
        `${matched} match published points here (${app.hideCollected ? 'hidden' : 'dimmed'}).`)
      if (o.randomizeMineables) {
        warnings.push('This save randomizes ore types, so published ore categories may not match your world.')
      }
      warnings.push(...o.warnings)
    }
    for (const d of app.dumps.values()) {
      const here = d.planet === world.id
      lines.push(`Dump ${d.name} for ${d.planet}: ${plural(d.objects.length, 'object')}` +
        (d.duplicates ? ` (${d.duplicates} duplicates dropped)` : '') + (here ? '.' : `; switch to ${d.planet} to see it.`))
      warnings.push(...d.warnings.map((m) => `${d.name}: ${m}`))
    }
    ui.overlaySummary.replaceChildren(...lines.map((l) => h('span', { class: 'line' }, l)))

    ui.overlayWarnings.hidden = warnings.length === 0
    $('summary', ui.overlayWarnings).textContent = plural(warnings.length, 'warning')
    $('ul', ui.overlayWarnings).replaceChildren(...warnings.slice(0, MAX_WARNINGS).map((m) => h('li', null, m)),
      warnings.length > MAX_WARNINGS ? h('li', null, `…and ${warnings.length - MAX_WARNINGS} more`) : null)

    ui.saveSection.hidden = !save
    if (save) {
      ui.refreshSave.textContent = app.saveHandle ? 'Refresh save' : 'Re-import save…'
      ui.refreshSave.title = app.saveHandle
        ? `Read ${save.name} again from its file`
        : 'Pick the save file again (this browser cannot re-read a file by itself)'
      renderToggleList(ui.saveLayers, {
        layers: SAVE_LAYERS,
        counts: saveLayers.counts(),
        enabled: app.saveEnabled,
        onChange: (key, on) => {
          on ? app.saveEnabled.add(key) : app.saveEnabled.delete(key)
          saveLayers.sync(app.saveEnabled)
        },
      })
    }
    ui.dumpSection.hidden = !dump
    if (dump) {
      dumpList.render({ categories: cats.categories, groups: cats.groups, count: (id) => dumpLayers.count(id), enabled: app.dumpEnabled })
    }
  }

  function clearOverlay() {
    app.save = null
    app.saveHandle = null
    app.saveReadAt = 0
    app.savePersisted = false
    forgetSave()
    app.collected = new Set()
    app.dumps.clear()
    saveLayers.clear()
    dumpLayers.clear()
    map.closePopup()
    published.restyle(app.enabled)
    ui.importError.hidden = true
    renderOverlayBox()
    updateMaxBounds()
    renderPointCount()
  }

  // ---- DOM events --------------------------------------------------------------------------------
  ui.worldSelect.addEventListener('change', () => {
    navigate({ world: ui.worldSelect.value, layers: rawState().layers })
  })
  ui.search.addEventListener('input', () => {
    catList.filter(ui.search.value)
    dumpList.filter(ui.search.value)
  })
  ui.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.search.value) {
      e.preventDefault()
      ui.search.value = ''
      catList.filter('')
      dumpList.filter('')
    }
  })
  ui.goto.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      goto()
    }
  })
  ui.goto.addEventListener('input', () => {
    if (!ui.gotoError.hidden) {
      ui.gotoError.hidden = true
      ui.goto.removeAttribute('aria-invalid')
    }
  })
  ui.gotoGo.addEventListener('click', goto)
  ui.pinClear.addEventListener('click', () => setPin(null))
  /** @param {string} message */
  const showImportError = (message) => {
    ui.importStatus.textContent = ''
    ui.importError.replaceChildren(h('p', null, message))
    ui.importError.hidden = false
  }
  ui.importInput.addEventListener('change', async () => {
    const file = ui.importInput.files?.[0]
    if (!file) return
    try {
      await handleImport(file)
    } catch (e) {
      showImportError(`Import failed: ${errorMessage(e)}`)
    } finally {
      ui.importInput.value = '' // allow re-importing the same file
    }
  })
  // Where the browser can keep a handle to the picked file, use its picker instead, so the save can be
  // refreshed from the file later. Programmatic clicks (Re-import) and test file setters still work.
  ui.importInput.addEventListener('click', async (e) => {
    if (!canPickWithHandle() || !e.isTrusted) return
    e.preventDefault()
    try {
      const picked = await pickWithHandle()
      if (picked) await handleImport(picked.file, { handle: picked.handle })
    } catch (err) {
      showImportError(`Import failed: ${errorMessage(err)}`)
    }
  })
  ui.refreshSave.addEventListener('click', async () => {
    const handle = app.saveHandle
    if (!handle) {
      ui.importInput.click()
      return
    }
    ui.refreshSave.disabled = true
    try {
      const file = await rereadHandle(handle)
      await handleImport(file, { handle, mode: 'refresh' })
    } catch (e) {
      const gone = e instanceof DOMException && e.name === 'NotFoundError'
      showImportError(gone
        ? `${app.save?.name ?? 'The save'} is no longer where it was. Import it again.`
        : `Refresh failed: ${errorMessage(e)}`)
    } finally {
      ui.refreshSave.disabled = false
    }
  })
  ui.hideCollected.addEventListener('change', () => {
    app.hideCollected = ui.hideCollected.checked
    published.restyle(app.enabled)
    dumpLayers.restyle(app.dumpEnabled)
    renderOverlayBox()
    renderPointCount()
  })
  ui.clearOverlay.addEventListener('click', clearOverlay)
  // A button, not an <a href="#map">: the hash holds the view state.
  $('#skip-to-map').addEventListener('click', () => ui.map.focus())
  ui.emptyDismiss.addEventListener('click', () => {
    app.emptyDismissed = true
    renderEmptyState()
  })

  ui.panelToggle.addEventListener('click', () => setPanelOpen(ui.panelBody.hidden))

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return
    e.preventDefault()
    setPanelOpen(true)
    ui.search.focus()
    ui.search.select()
  })

  window.addEventListener('hashchange', () => {
    navigate(decodeHash(location.hash))
  })

  // ---- go --------------------------------------------------------------------------------------
  /** Read-only debug / test handle. */
  Object.defineProperty(window, '__pcmap', {
    value: Object.freeze({ map, getState, index }),
    configurable: true,
  })

  await navigate(decodeHash(location.hash))
  await restoreSave()

  /** Bring back the save remembered on this device, unless a file was imported in the meantime. */
  async function restoreSave() {
    const stored = await loadSave()
    if (!stored || app.save) return
    // The live file when the browser still lets us read it silently (it may have changed since)...
    const live = stored.handle ? await rereadIfGranted(stored.handle) : null
    if (app.save) return
    if (live) {
      try {
        await handleImport(live, { handle: stored.handle, mode: 'refresh' })
      } catch {
        // fall back to the remembered copy below
      }
      if (app.save) return
    }
    // ...the remembered copy otherwise.
    try {
      const file = new File([stored.bytes], stored.name, { type: 'application/json' })
      await handleImport(file, { handle: stored.handle, mode: 'restore', readAt: stored.savedAt })
    } catch (e) {
      showImportError(`Could not restore ${stored.name}: ${errorMessage(e)}`)
    }
    if (!app.save) {
      // Unreadable now (a parser change, a damaged entry): forget it so it does not fail on every visit.
      forgetSave()
      if (ui.importError.hidden) showImportError(`The remembered save ${stored.name} could not be read and was forgotten.`)
    }
  }
}

/** @param {number} ms */
function formatReadAt(ms) {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? `at ${time}` : `${d.toLocaleDateString()} ${time}`
}

/** @param {string} url */
async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

/** @param {unknown} e */
const errorMessage = (e) => (e instanceof Error ? e.message : String(e))

/** @param {EventTarget|null} t */
function isEditable(t) {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
}

/** @param {string} key */
function storageGet(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** @param {string} key @param {string} value */
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode / storage disabled: the URL still holds the state
  }
}
