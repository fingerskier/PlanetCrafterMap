// Category taxonomy compiler. Pure: no DOM, safe in Node and the browser.
//
// Input is `data/categories.json` (pcmap-categories/1), or the `groups` + `categories` of a generated
// `index.json` (pcmap-index/1, which already contains the implicit `other` category). See
// docs/ARCHITECTURE.md. A gId goes to the FIRST category in file order with a matching entry; entries
// are exact gIds or `/regex/flags` strings. Unmatched gIds go to the implicit category `other`.

/** Id of the implicit fallback category and of its group. */
export const OTHER_ID = 'other'

const FORMATS = new Set(['pcmap-categories/1', 'pcmap-index/1'])
// Ids end up in the URL hash (`l=iron,cobalt`), so keep them to lowercase slugs.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
// `g` and `y` would make RegExp#test stateful, so only these flags are allowed.
const REGEX_ENTRY_RE = /^\/(.+)\/([imsu]*)$/s

/**
 * @typedef {{ id: string, label: string }} Group
 * @typedef {{ id: string, label: string, group: string, color: string, match: string[] }} Category
 * @typedef {object} CompiledCategories
 * @property {Category[]} categories file order, with the implicit `other` category last
 * @property {Group[]} groups file order, with the `other` group last if the input did not declare it
 * @property {(gId: string) => string} classify gId -> category id (memoized; `other` when unmatched)
 * @property {Map<string, Category>} byId category id -> category (includes `other`)
 */

/**
 * Validate and compile a category taxonomy. Throws an Error listing every problem found.
 * @param {unknown} json parsed pcmap-categories/1 (or pcmap-index/1) object
 * @returns {CompiledCategories}
 */
export function compileCategories(json) {
  /** @type {string[]} */
  const errors = []
  const fail = () => {
    throw new Error(`invalid categories: ${errors.length} problem(s)\n  - ${errors.join('\n  - ')}`)
  }
  if (!isObject(json)) {
    errors.push('expected a JSON object')
    fail()
  }
  const src = /** @type {Record<string, any>} */ (json)
  if (src.format !== undefined && !FORMATS.has(src.format)) {
    errors.push(`format must be one of ${[...FORMATS].join(', ')} (got ${JSON.stringify(src.format)})`)
  }
  if (!Array.isArray(src.groups)) errors.push('groups must be an array')
  if (!Array.isArray(src.categories)) errors.push('categories must be an array')
  if (errors.length) fail()

  /** @type {Group[]} */
  const groups = []
  const groupIds = new Set()
  src.groups.forEach((/** @type {any} */ g, /** @type {number} */ i) => {
    const at = `groups[${i}]`
    if (!isObject(g)) return errors.push(`${at}: must be an object`)
    if (typeof g.id !== 'string' || !SLUG_RE.test(g.id)) {
      return errors.push(`${at}: id must be a lowercase slug (got ${JSON.stringify(g.id)})`)
    }
    if (groupIds.has(g.id)) return errors.push(`${at}: duplicate group id '${g.id}'`)
    if (!isLabel(g.label)) errors.push(`${at} '${g.id}': label must be a non-empty string`)
    groupIds.add(g.id)
    groups.push({ id: g.id, label: String(g.label) })
  })
  if (!groupIds.has(OTHER_ID)) {
    groups.push({ id: OTHER_ID, label: 'Other' })
    groupIds.add(OTHER_ID)
  }

  /** @type {Category[]} */
  const categories = []
  /** @type {Category|null} */
  let other = null
  const categoryIds = new Set()
  /** @type {Map<string, number>} exact gId -> index into `categories` */
  const exact = new Map()
  /** @type {Map<string, string>} exact gId -> owning category id (for duplicate reporting) */
  const exactOwner = new Map()
  /** @type {{ re: RegExp, index: number }[]} in file order */
  const regexes = []

  src.categories.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const at = `categories[${i}]`
    if (!isObject(c)) return errors.push(`${at}: must be an object`)
    if (typeof c.id !== 'string' || !SLUG_RE.test(c.id)) {
      return errors.push(`${at}: id must be a lowercase slug (got ${JSON.stringify(c.id)})`)
    }
    const name = `${at} '${c.id}'`
    if (categoryIds.has(c.id)) return errors.push(`${name}: duplicate category id`)
    categoryIds.add(c.id)
    if (!isLabel(c.label)) errors.push(`${name}: label must be a non-empty string`)
    if (typeof c.group !== 'string' || !groupIds.has(c.group)) {
      errors.push(`${name}: group ${JSON.stringify(c.group)} is not declared in groups`)
    }
    if (typeof c.color !== 'string' || !COLOR_RE.test(c.color)) {
      errors.push(`${name}: color must be #rrggbb (got ${JSON.stringify(c.color)})`)
    }
    if (!Array.isArray(c.match)) return errors.push(`${name}: match must be an array of strings`)

    if (c.id === OTHER_ID) {
      // Allowed so a generated index.json round-trips, but it is the fallback and matches nothing.
      if (c.match.length) errors.push(`${name}: the implicit fallback category cannot have match entries`)
      other = { id: OTHER_ID, label: c.label, group: c.group, color: String(c.color).toLowerCase(), match: [] }
      return
    }
    if (!c.match.length) errors.push(`${name}: match must not be empty`)

    const index = categories.length
    c.match.forEach((/** @type {any} */ m, /** @type {number} */ j) => {
      const mat = `${name}.match[${j}]`
      if (typeof m !== 'string' || !m.length) return errors.push(`${mat}: must be a non-empty string`)
      if (m.startsWith('/')) {
        const parts = REGEX_ENTRY_RE.exec(m)
        if (!parts) return errors.push(`${mat}: regex entries must look like /pattern/ with flags from [imsu] (got ${m})`)
        try {
          regexes.push({ re: new RegExp(parts[1], parts[2]), index })
        } catch (e) {
          errors.push(`${mat}: regex does not compile: ${/** @type {Error} */ (e).message}`)
        }
        return
      }
      const owner = exactOwner.get(m)
      if (owner !== undefined) {
        return errors.push(`${mat}: gId '${m}' is already matched exactly by category '${owner}'`)
      }
      exactOwner.set(m, c.id)
      exact.set(m, index)
    })
    categories.push({ id: c.id, label: c.label, group: c.group, color: String(c.color).toLowerCase(), match: [...c.match] })
  })
  if (errors.length) fail()

  categories.push(other ?? { id: OTHER_ID, label: 'Other', group: OTHER_ID, color: '#8b949e', match: [] })
  const byId = new Map(categories.map((c) => [c.id, c]))

  /** @type {Map<string, string>} */
  const memo = new Map()
  /** @param {string} gId */
  const classify = (gId) => {
    if (typeof gId !== 'string') return OTHER_ID
    const hit = memo.get(gId)
    if (hit !== undefined) return hit
    // File order decides: a regex in an earlier category beats an exact entry in a later one.
    let best = exact.get(gId) ?? Infinity
    for (const { re, index } of regexes) {
      if (index >= best) break
      if (re.test(gId)) {
        best = index
        break
      }
    }
    const id = best === Infinity ? OTHER_ID : categories[best].id
    memo.set(gId, id)
    return id
  }

  return { categories, groups, classify, byId }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** @param {unknown} v */
const isLabel = (v) => typeof v === 'string' && v.trim().length > 0
