// Popup content for map points. Built as DOM (never HTML strings): gIds and names may come from
// imported, untrusted files.

import { formatHud } from '../lib/coords.js'
import { copyText, h } from './dom.js'

/**
 * @typedef {object} PopupInfo
 * @property {string} title e.g. the category label
 * @property {string} color dot colour (#rrggbb)
 * @property {string} [source] small caption, e.g. "Your save"
 * @property {string} [gId]
 * @property {number} x
 * @property {number|null} y
 * @property {number} z
 * @property {number} [id] shown when non-zero
 * @property {boolean} [collected] adds a "collected" badge
 * @property {[string, string][]} [extra] more label/value rows
 */

/**
 * @param {PopupInfo} info
 * @returns {HTMLElement}
 */
export function popupContent(info) {
  const hud = formatHud(info.x, info.y, info.z)
  const dot = h('span', { class: 'dot', 'aria-hidden': 'true' })
  dot.style.background = info.color
  const rows = /** @type {[string, string][]} */ ([])
  if (info.gId) rows.push(['gId', info.gId])
  rows.push(['X:Y:Z', hud])
  if (info.id) rows.push(['id', String(info.id)])
  rows.push(...(info.extra ?? []))

  const copy = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn-small', 'data-testid': 'popup-copy' }, 'Copy X:Y:Z'))
  copy.addEventListener('click', async () => {
    const ok = await copyText(hud)
    copy.textContent = ok ? 'Copied' : 'Copy failed'
    setTimeout(() => {
      copy.textContent = 'Copy X:Y:Z'
    }, 1500)
  })

  return h('div', { class: 'pc-popup', 'data-testid': 'popup' },
    h('div', { class: 'pc-popup-title' },
      dot,
      h('strong', null, info.title),
      info.collected ? h('span', { class: 'badge', 'data-testid': 'collected-badge' }, 'collected') : null),
    info.source ? h('div', { class: 'pc-popup-source' }, info.source) : null,
    h('dl', null, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, h('code', null, v))])),
    copy)
}

/**
 * Open a layer's popup on click, and on Enter or Space while one of its markers has keyboard focus.
 * Leaflet gives `keyboard: true` markers tabindex=0 and role=button, but only bindPopup handles keys.
 * @param {import('leaflet').Evented} layer a marker, or a group (its handler gets `propagatedFrom`)
 * @param {(e: any) => void} open
 */
export function onActivate(layer, open) {
  layer.on('click', open)
  layer.on('keydown', (/** @type {any} */ e) => {
    const key = e.originalEvent?.key
    if (key !== 'Enter' && key !== ' ') return
    e.originalEvent.preventDefault()
    open(e)
  })
}
