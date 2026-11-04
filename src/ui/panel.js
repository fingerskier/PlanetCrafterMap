// Panel widgets: the grouped category checklist (published data and dump) and the save-layer toggles.

import { h } from './dom.js'

/**
 * @typedef {import('../lib/categories.js').Category} Category
 * @typedef {import('../lib/categories.js').Group} Group
 */

/**
 * Grouped checklist of categories. Categories with no points are left out; groups with nothing to show
 * are hidden. Search filtering hides items without rebuilding them.
 */
export class CategoryList {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} opts.prefix data-testid prefix for checkboxes, e.g. 'cat' -> data-testid="cat-iron"
   * @param {string} opts.emptyText shown when no category has points
   * @param {(ids: string[], on: boolean) => void} opts.onChange
   */
  constructor(container, { prefix, emptyText, onChange }) {
    this.container = container
    this.prefix = prefix
    this.emptyText = emptyText
    this.onChange = onChange
    this.query = ''
    /** @type {{ el: HTMLElement, button: HTMLButtonElement, label: string, items: { id: string, li: HTMLElement, input: HTMLInputElement, text: string }[] }[]} */
    this.groups = []
    /** @type {HTMLElement|null} */
    this.noMatch = null
  }

  /**
   * @param {object} o
   * @param {Category[]} o.categories in display order
   * @param {Group[]} o.groups in display order
   * @param {(id: string) => number} o.count
   * @param {Set<string>} o.enabled
   */
  render({ categories, groups, count, enabled }) {
    this.container.replaceChildren()
    this.groups = []
    for (const g of groups) {
      const cats = categories.filter((c) => c.group === g.id && count(c.id) > 0)
      if (!cats.length) continue
      const headId = `${this.prefix}-group-${g.id}`
      const button = /** @type {HTMLButtonElement} */ (h('button', {
        type: 'button', class: 'btn btn-small', 'data-testid': `${this.prefix}-group-toggle-${g.id}`,
      }, 'All'))
      const items = cats.map((c) => {
        const n = count(c.id)
        const input = /** @type {HTMLInputElement} */ (h('input', {
          type: 'checkbox', 'data-testid': `${this.prefix}-${c.id}`, 'data-count': String(n), checked: enabled.has(c.id),
        }))
        input.addEventListener('change', () => this.onChange([c.id], input.checked))
        const dot = h('span', { class: 'dot', 'aria-hidden': 'true' })
        dot.style.background = c.color
        const li = h('li', { class: 'cat' },
          h('label', { class: 'check' }, input, dot, h('span', { class: 'cat-label' }, c.label),
            h('span', { class: 'count' }, String(n))))
        const text = [c.label, c.id, g.label, ...c.match.filter((m) => !m.startsWith('/'))].join(' ').toLowerCase()
        return { id: c.id, li, input, text }
      })
      const group = {
        el: h('div', { class: 'cat-group', role: 'group', 'aria-labelledby': headId },
          h('div', { class: 'cat-group-head' }, h('span', { id: headId, class: 'cat-group-label' }, g.label), button),
          h('ul', { class: 'cats' }, items.map((i) => i.li))),
        button,
        label: g.label,
        items,
      }
      button.addEventListener('click', () => {
        const shown = group.items.filter((i) => !i.li.hidden)
        const on = !shown.every((i) => i.input.checked)
        this.onChange(shown.map((i) => i.id), on)
      })
      this.groups.push(group)
      this.container.append(group.el)
    }
    if (!this.groups.length) this.container.append(h('p', { class: 'meta' }, this.emptyText))
    this.noMatch = h('p', { class: 'meta', hidden: true })
    this.container.append(this.noMatch)
    this.filter(this.query)
  }

  /** @param {Set<string>} enabled */
  setEnabled(enabled) {
    for (const g of this.groups) for (const i of g.items) i.input.checked = enabled.has(i.id)
    this.updateButtons()
  }

  /** @param {string} query */
  filter(query) {
    this.query = query
    const q = query.trim().toLowerCase()
    let any = false
    for (const g of this.groups) {
      let shown = 0
      for (const i of g.items) {
        i.li.hidden = q !== '' && !i.text.includes(q)
        if (!i.li.hidden) shown++
      }
      g.el.hidden = shown === 0
      any ||= shown > 0
    }
    if (this.noMatch) {
      this.noMatch.hidden = any || !this.groups.length
      this.noMatch.textContent = `No categories match "${query.trim()}".`
    }
    this.updateButtons()
  }

  updateButtons() {
    for (const g of this.groups) {
      const shown = g.items.filter((i) => !i.li.hidden)
      const allOn = shown.length > 0 && shown.every((i) => i.input.checked)
      const text = allOn ? 'None' : 'All'
      g.button.textContent = text
      g.button.setAttribute('aria-label', `${text} (${allOn ? 'hide' : 'show'} every ${g.label} category)`)
    }
  }
}

/**
 * Checkbox list for the save layers (only the layers with something to show).
 * @param {HTMLElement} container
 * @param {object} o
 * @param {{ key: string, label: string, color: string }[]} o.layers
 * @param {Record<string, number>} o.counts
 * @param {Set<string>} o.enabled
 * @param {(key: string, on: boolean) => void} o.onChange
 */
export function renderToggleList(container, { layers, counts, enabled, onChange }) {
  container.replaceChildren()
  const shown = layers.filter((l) => (counts[l.key] ?? 0) > 0)
  if (!shown.length) {
    container.append(h('p', { class: 'meta' }, 'Nothing from your save on this world.'))
    return
  }
  container.append(h('ul', { class: 'cats' }, shown.map((l) => {
    const n = counts[l.key]
    const input = /** @type {HTMLInputElement} */ (h('input', {
      type: 'checkbox', 'data-testid': `save-${l.key}`, 'data-count': String(n), checked: enabled.has(l.key),
    }))
    input.addEventListener('change', () => onChange(l.key, input.checked))
    const dot = h('span', { class: `dot dot-${l.key}`, 'aria-hidden': 'true' })
    dot.style.background = l.key === 'instances' ? 'transparent' : l.color
    dot.style.borderColor = l.color
    return h('li', { class: 'cat' },
      h('label', { class: 'check' }, input, dot, h('span', { class: 'cat-label' }, l.label),
        h('span', { class: 'count' }, String(n))))
  })))
}
