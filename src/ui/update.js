// New versions. The service worker calls skipWaiting() + clients.claim(), so after a deploy it takes over a
// page that still runs the previous shell and index.json, while world files now come from the new precache.
// Such a page reloads into the new version, unless it holds imported files (they live only in memory and a
// reload drops them): then it shows a "Map updated" notice with a Reload button. At most one automatic
// reload per tab session (sessionStorage), so a mismatch a reload cannot fix never loops.

import { h } from './dom.js'

const RELOADED_KEY = 'pcmap:update-reloaded'

/**
 * Claim this tab session's one automatic reload. False when it was already used, or when sessionStorage is
 * missing or unusable (then a reload could not be counted, so none happens).
 * @param {Pick<Storage, 'getItem'|'setItem'>|null|undefined} storage
 * @returns {boolean}
 */
export function claimAutoReload(storage) {
  try {
    if (!storage || storage.getItem(RELOADED_KEY) !== null) return false
    storage.setItem(RELOADED_KEY, String(Date.now()))
    return storage.getItem(RELOADED_KEY) !== null
  } catch {
    return false
  }
}

/**
 * Build the handler for "this page runs an outdated version". Only its first call acts.
 * @param {object} opts
 * @param {HTMLElement} opts.notice role="status" container the notice is rendered into
 * @param {() => boolean} opts.holdsImports true while imported files are loaded
 * @param {() => void} [opts.reload]
 * @param {() => Pick<Storage, 'getItem'|'setItem'>|null} [opts.storage] defaults to sessionStorage
 * @returns {() => void}
 */
export function createUpdateHandler({ notice, holdsImports, reload = () => location.reload(), storage = sessionStore }) {
  let handled = false
  return () => {
    if (handled) return
    handled = true
    const imports = holdsImports()
    if (!imports && claimAutoReload(storage())) {
      reload()
      return
    }
    const dismiss = h('button', {
      type: 'button', class: 'btn btn-icon btn-small', 'aria-label': 'Dismiss', 'data-testid': 'update-dismiss',
      onclick: () => notice.replaceChildren(),
    }, '×')
    notice.replaceChildren(h('div', { class: 'update-card' },
      h('span', null, imports ? 'Map updated. Reloading clears your imported files.' : 'Map updated.'),
      h('button', { type: 'button', class: 'btn btn-small', 'data-testid': 'update-reload', onclick: reload }, 'Reload'),
      dismiss))
  }
}

function sessionStore() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}
