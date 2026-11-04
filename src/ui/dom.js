// Tiny DOM helpers. All user-provided text (gIds, player names, file names) goes through text nodes,
// never innerHTML, because imported files are untrusted.

/**
 * Create an element. `props` keys: `class`, `dataset` (object), `on<event>` (listener), DOM properties
 * given as non-strings (e.g. `checked: true`, `hidden: false`), and attributes (strings / numbers / true).
 * null, undefined and false values are skipped. Children: nodes, strings, numbers; null/false skipped.
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (typeof v === 'boolean' && k in el) /** @type {any} */ (el)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  append(el, children)
  return el
}

/**
 * @param {Element} el
 * @param {any[]} children
 */
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c)
  }
}

/**
 * Required element lookup (the static shell in index.html must contain it).
 * @template {HTMLElement} T
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T}
 */
export function $(selector, root = document) {
  const el = root.querySelector(selector)
  if (!el) throw new Error(`missing element ${selector}`)
  return /** @type {T} */ (el)
}

/** @param {number} n */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Copy text to the clipboard: the async Clipboard API, else a hidden-textarea + execCommand fallback
 * (insecure contexts, older WebViews).
 * @param {string} text
 * @returns {Promise<boolean>} whether it (probably) worked
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' }))
  ta.value = text
  document.body.append(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}
