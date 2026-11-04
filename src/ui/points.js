// Category point layers: one L.circleMarker per point, one L.featureGroup per category, created lazily
// the first time a category is shown. Used for the published data and for an imported dump.

import L from 'leaflet'
import { toLatLng } from '../lib/coords.js'
import { popupContent } from './popup.js'

/**
 * @typedef {{ gId: string, x: number, y: number, z: number, id: number }} MapPoint id 0 = unknown
 * @typedef {import('../lib/categories.js').Category} Category
 * @typedef {{ collected: Set<number>, hide: boolean }} Marks
 */

/**
 * Bucket points by category id (classification is memoized by the compiled categories).
 * @param {Iterable<MapPoint>} points
 * @param {(gId: string) => string} classify
 * @returns {Map<string, MapPoint[]>}
 */
export function bucketByCategory(points, classify) {
  /** @type {Map<string, MapPoint[]>} */
  const out = new Map()
  for (const p of points) {
    const id = classify(p.gId)
    let list = out.get(id)
    if (!list) out.set(id, (list = []))
    list.push(p)
  }
  return out
}

/**
 * Points of a pcmap-world/1 file.
 * @param {{ gids: string[], points: [number, number, number, number, number][] }} data
 * @returns {MapPoint[]}
 */
export function worldPoints(data) {
  const out = []
  for (const p of data.points) {
    const gId = data.gids[p[0]]
    if (typeof gId !== 'string' || !Number.isFinite(p[1]) || !Number.isFinite(p[3])) continue
    out.push({ gId, x: p[1], y: Number.isFinite(p[2]) ? p[2] : 0, z: p[3], id: Number.isInteger(p[4]) ? p[4] : 0 })
  }
  return out
}

export class CategoryLayers {
  /**
   * @param {L.Map} map
   * @param {object} opts
   * @param {L.Renderer} opts.renderer
   * @param {Map<string, Category>} opts.categories category id -> category
   * @param {() => Marks} opts.marks collected ids and whether to hide them
   * @param {string} [opts.source] popup caption (e.g. "Your dump")
   * @param {string} [opts.stroke] marker outline colour
   */
  constructor(map, { renderer, categories, marks, source, stroke = '#0d1117' }) {
    this.map = map
    this.renderer = renderer
    this.categories = categories
    this.marks = marks
    this.source = source
    this.stroke = stroke
    /** @type {Map<string, MapPoint[]>} */
    this.byCat = new Map()
    /** @type {Map<string, L.FeatureGroup>} */
    this.groups = new Map()
    this.radius = 5
  }

  /** Marker radius in px (smaller when zoomed out, to reduce clutter). @param {number} r */
  setRadius(r) {
    if (r === this.radius) return
    this.radius = r
    for (const g of this.groups.values()) g.eachLayer((m) => /** @type {L.CircleMarker} */ (m).setRadius(r))
  }

  /** Replace the points (e.g. on world switch). Existing groups are dropped. @param {Map<string, MapPoint[]>} byCat */
  setPoints(byCat) {
    this.clear()
    this.byCat = byCat
  }

  /** @param {string} catId */
  count(catId) {
    return this.byCat.get(catId)?.length ?? 0
  }

  get total() {
    let n = 0
    for (const list of this.byCat.values()) n += list.length
    return n
  }

  /**
   * Points currently drawn for the enabled categories (collected points count unless hidden).
   * @param {Set<string>} enabled
   */
  visibleCount(enabled) {
    const { collected, hide } = this.marks()
    let n = 0
    for (const [id, list] of this.byCat) {
      if (!enabled.has(id)) continue
      if (!hide || !collected.size) n += list.length
      else for (const p of list) if (!(p.id && collected.has(p.id))) n++
    }
    return n
  }

  /** Show exactly the enabled categories that have points. @param {Set<string>} enabled */
  sync(enabled) {
    for (const id of this.byCat.keys()) {
      const want = enabled.has(id) && this.count(id) > 0
      const group = this.groups.get(id)
      if (want) {
        const g = group ?? this.build(id)
        if (!this.map.hasLayer(g)) g.addTo(this.map)
      } else if (group && this.map.hasLayer(group)) {
        group.remove()
      }
    }
  }

  /** Collected ids or hide/dim changed: rebuild what was built. @param {Set<string>} enabled */
  restyle(enabled) {
    for (const g of this.groups.values()) g.remove()
    this.groups.clear()
    this.sync(enabled)
  }

  clear() {
    for (const g of this.groups.values()) g.remove()
    this.groups.clear()
    this.byCat = new Map()
  }

  /** @param {string} catId */
  build(catId) {
    const cat = this.categories.get(catId)
    const color = cat?.color ?? '#8b949e'
    const { collected, hide } = this.marks()
    const group = L.featureGroup()
    for (const p of this.byCat.get(catId) ?? []) {
      const isCollected = p.id !== 0 && collected.has(p.id)
      if (isCollected && hide) continue
      const m = L.circleMarker(toLatLng(p.x, p.z), {
        renderer: this.renderer,
        radius: this.radius,
        color: this.stroke,
        weight: 1.25,
        opacity: isCollected ? 0.35 : 0.9,
        fillColor: color,
        fillOpacity: isCollected ? 0.22 : 0.9,
      })
      group.addLayer(Object.assign(m, { pcPoint: p }))
    }
    // One delegated handler per group instead of one popup binding per marker.
    group.on('click', (/** @type {any} */ e) => {
      const marker = e.propagatedFrom ?? e.layer
      const p = /** @type {MapPoint|undefined} */ (marker?.pcPoint)
      if (!p) return
      const content = popupContent({
        title: cat?.label ?? catId,
        color,
        source: this.source,
        gId: p.gId,
        x: p.x,
        y: p.y,
        z: p.z,
        id: p.id,
        collected: p.id !== 0 && this.marks().collected.has(p.id),
      })
      L.popup({ maxWidth: 280, autoPanPadding: L.point(24, 24) }).setLatLng(marker.getLatLng()).setContent(content).openOn(this.map)
    })
    this.groups.set(catId, group)
    return group
  }
}
