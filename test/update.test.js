import { describe, expect, it, vi } from 'vitest'
import { claimAutoReload, createUpdateHandler, watchControllerChange } from '../src/ui/update.js'

/** In-memory Storage stand-in. */
function memoryStorage() {
  const m = new Map()
  return { getItem: (/** @type {string} */ k) => (m.has(k) ? m.get(k) : null), setItem: (/** @type {string} */ k, /** @type {string} */ v) => m.set(k, String(v)) }
}

describe('claimAutoReload', () => {
  it('allows one automatic reload per session storage', () => {
    const s = memoryStorage()
    expect(claimAutoReload(s)).toBe(true)
    expect(claimAutoReload(s)).toBe(false)
    expect(claimAutoReload(s)).toBe(false)
  })

  it('never allows one when the reload cannot be counted', () => {
    expect(claimAutoReload(null)).toBe(false)
    expect(claimAutoReload(undefined)).toBe(false)
    const throwing = { getItem: () => { throw new Error('SecurityError') }, setItem: () => {} }
    expect(claimAutoReload(throwing)).toBe(false)
    const quota = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(claimAutoReload(quota)).toBe(false)
    const ignoring = { getItem: () => null, setItem: () => {} } // a write that silently does nothing
    expect(claimAutoReload(ignoring)).toBe(false)
  })
})

describe('createUpdateHandler', () => {
  it('reloads once when nothing is imported, and ignores later calls', () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    const notice = /** @type {any} */ ({ replaceChildren: vi.fn() })
    const outdated = createUpdateHandler({ notice, holdsImports: () => false, reload, storage: () => storage })
    outdated()
    outdated()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(notice.replaceChildren).not.toHaveBeenCalled()
  })
})

describe('watchControllerChange', () => {
  /** @param {object|null} controller */
  function fakeContainer(controller) {
    const target = new EventTarget()
    return { controller, addEventListener: target.addEventListener.bind(target), fire: () => target.dispatchEvent(new Event('controllerchange')) }
  }

  it('on a first visit, ignores the initial claim but reports every later deploy', () => {
    const sw = fakeContainer(null)
    const onUpdate = vi.fn()
    watchControllerChange(sw, onUpdate)
    sw.fire() // the first worker claims the page
    expect(onUpdate).not.toHaveBeenCalled()
    sw.fire() // a later deploy, tab still open
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('on a page controlled at startup, reports the first change', () => {
    const sw = fakeContainer({})
    const onUpdate = vi.fn()
    watchControllerChange(sw, onUpdate)
    sw.fire()
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('does nothing without service worker support', () => {
    expect(() => watchControllerChange(undefined, vi.fn())).not.toThrow()
  })
})
