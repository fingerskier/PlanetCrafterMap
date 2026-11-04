// Map layers for an imported save (one world's part of a SaveOverlay): players, placed objects by
// origin, and procedural wreck sites. Each kind is its own toggle; groups are built lazily.

import L from 'leaflet'
import { toLatLng } from '../lib/coords.js'
import { popupContent } from './popup.js'

/**
 * @typedef {import('../lib/save.js').OverlayWorld} OverlayWorld
 * @typedef {'players'|'built'|'wreck'|'scene'|'unknown'|'instances'} SaveLayerKey
 */

/** @type {{ key: SaveLayerKey, label: string, color: string }[]} */
export const SAVE_LAYERS = [
  { key: 'players', label: 'Players', color: '#ffffff' },
  { key: 'built', label: 'Built by players', color: '#58a6ff' },
  { key: 'wreck', label: 'Wreck contents', color: '#f0883e' },
  { key: 'scene', label: 'Scene objects with saved state', color: '#d2a8ff' },
  { key: 'unknown', label: 'Other placed objects', color: '#a0a8b2' },
  { key: 'instances', label: 'Procedural wreck sites', color: '#ff7b72' },
]
const BY_KEY = new Map(SAVE_LAYERS.map((l) => [l.key, l]))
const SOURCE = 'Your save'

export class SaveLayers {
  /** @param {L.Map} map @param {L.Renderer} renderer */
  constructor(map, renderer) {
    this.map = map
    this.renderer = renderer
    /** @type {OverlayWorld|null} */
    this.part = null
    /** @type {Map<SaveLayerKey, L.FeatureGroup>} */
    this.groups = new Map()
  }

  /** @param {OverlayWorld|null} part */
  setWorld(part) {
    this.clear()
    this.part = part
  }

  /** @returns {Record<SaveLayerKey, number>} */
  counts() {
    const c = { players: 0, built: 0, wreck: 0, scene: 0, unknown: 0, instances: 0 }
    if (!this.part) return c
    c.players = this.part.players.length
    c.instances = this.part.instances.length
    for (const o of this.part.objects) c[o.origin]++
    return c
  }

  get total() {
    const c = this.counts()
    return c.players + c.built + c.wreck + c.scene + c.unknown + c.instances
  }

  /** @param {Set<string>} enabled */
  sync(enabled) {
    const counts = this.counts()
    for (const { key } of SAVE_LAYERS) {
      const want = enabled.has(key) && counts[key] > 0
      const group = this.groups.get(key)
      if (want) {
        const g = group ?? this.build(key)
        if (!this.map.hasLayer(g)) g.addTo(this.map)
      } else if (group && this.map.hasLayer(group)) {
        group.remove()
      }
    }
  }

  clear() {
    for (const g of this.groups.values()) g.remove()
    this.groups.clear()
    this.part = null
  }

  /** @param {SaveLayerKey} key */
  build(key) {
    const def = /** @type {{ label: string, color: string }} */ (BY_KEY.get(key))
    const group = L.featureGroup()
    const part = this.part
    if (part && key === 'players') {
      for (const p of part.players) {
        const icon = L.divIcon({ className: 'pc-player', iconSize: [18, 18], html: '<span></span>' })
        const m = L.marker(toLatLng(p.x, p.z), { icon, keyboard: true, title: p.name || 'Player', alt: 'Player', zIndexOffset: 1000 })
        group.addLayer(Object.assign(m, { pcInfo: { title: p.name ? `Player: ${p.name}` : 'Player', color: def.color, source: SOURCE, x: p.x, y: p.y, z: p.z } }))
      }
    } else if (part && key === 'instances') {
      for (const w of part.instances) {
        const m = L.circleMarker(toLatLng(w.x, w.z), {
          renderer: this.renderer, radius: 9, color: def.color, weight: 2.5, dashArray: '4 3', fill: true, fillOpacity: 0.08,
        })
        /** @type {[string, string][]} */
        const extra = []
        if (w.seed !== null) extra.push(['seed', String(w.seed)])
        if (w.index !== null) extra.push(['index', String(w.index)])
        group.addLayer(Object.assign(m, { pcInfo: { title: def.label.replace(/s$/, ''), color: def.color, source: SOURCE, x: w.x, y: w.y, z: w.z, extra } }))
      }
    } else if (part) {
      for (const o of part.objects) {
        if (o.origin !== key) continue
        const m = L.circleMarker(toLatLng(o.x, o.z), {
          renderer: this.renderer, radius: 4, color: '#0d1117', weight: 1, fillColor: def.color, fillOpacity: 0.9,
        })
        group.addLayer(Object.assign(m, { pcInfo: { title: def.label, color: def.color, source: SOURCE, gId: o.gId, x: o.x, y: o.y, z: o.z, id: o.id } }))
      }
    }
    group.on('click', (/** @type {any} */ e) => {
      const marker = e.propagatedFrom ?? e.layer
      const info = marker?.pcInfo
      if (!info) return
      L.popup({ maxWidth: 280, autoPanPadding: L.point(24, 24) }).setLatLng(marker.getLatLng()).setContent(popupContent(info)).openOn(this.map)
    })
    this.groups.set(key, group)
    return group
  }
}
