import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OTHER_ID, compileCategories } from '../src/lib/categories.js'

const json = JSON.parse(readFileSync(new URL('../data/categories.json', import.meta.url), 'utf8'))
const compiled = compileCategories(json)
const range = (prefix, from, to, suffix = '') =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}${suffix}`)

// Every gId named in the research notes (exact spellings, including the game's own quirks).
const MINABLES = ['Cobalt', 'Silicon', 'Iron', 'ice', 'Magnesium', 'Titanium', 'Aluminium', 'Uranim', 'Iridium',
  'Alloy', 'Zeolite', 'Osmium', 'Sulfur', 'PulsarQuartz', 'PulsarShard', 'Obsidian', 'SolarQuartz',
  'MagnetarQuartz', 'BalzarQuartz', 'QuasarQuartz', 'Dolomite', 'Uraninite', 'Bauxite', 'CosmicQuartz',
  'Selenium', 'Phosphorus', 'ToxicGoo', 'ToxicSpores', 'Minable-Tungsten', 'PristineMushroom', 'Amber']
const POIS = ['Container1', 'Container2', 'Container3', 'GoldenContainer', 'StarformContainer', 'ContainerAqualis',
  'ContainerGoldenAqualis', 'DebrisContainer1', 'ProceduralWreckContainer1', 'ProceduralWreckContainer2',
  'WreckSafe', 'ProceduralWreckSafe', 'WreckServer', 'wreckpilar', 'WreckFusionGenerator', 'WreckWardrobe',
  ...range('WreckEntryLocked', 1, 5), 'WardenAustel', 'WardenKey', 'DroneLog', 'canister', 'TrashMetalsCanisters1',
  'PortalGenerator1', ...range('GoldenEffigie', 1, 9), ...range('GoldenToxicityEffigie', 1, 6),
  ...range('StarformEffigie', 1, 6), ...range('AnimalEffigie', 1, 10), ...range('Poster', 1, 13), 'AnimalBones',
  'WreckRockExplodable', 'GenerationGroupVein', 'RockExplodable', 'ProceduralInstanceGenerator']
const LIFE = [...range('LarvaeBase', 1, 3), ...range('Butterfly', 11, 21, 'Larvae'), ...range('Fish', 1, 15, 'Eggs'),
  ...range('Frog', 1, 16, 'Eggs'), 'FrogGoldEggs']

describe('data/categories.json', () => {
  it('is pcmap-categories/1 and compiles', () => {
    expect(json.format).toBe('pcmap-categories/1')
    expect(compiled.categories.length).toBe(json.categories.length + 1)
  })

  it.each([...MINABLES, ...POIS, ...LIFE])('classifies research gId %s', (gId) => {
    expect(compiled.classify(gId)).not.toBe(OTHER_ID)
  })

  it.each([
    ['Uranim', 'uranium'], ['BalzarQuartz', 'blazar-quartz'], ['ice', 'ice'], ['Alloy', 'super-alloy'],
    ['Minable-Tungsten', 'tungsten'], ['Aluminium', 'aluminium'], ['Container1', 'storage-crate'],
    ['Container2', 'storage-crate'], ['Container3', 'storage-crate'], ['GenerationGroupVein', 'ore-vein'],
    ['RockExplodable', 'explodable-rock'], ['WreckRockExplodable', 'wreck-rock'], ['FrogGoldEggs', 'golden-frog-eggs'],
  ])('%s -> %s', (gId, id) => expect(compiled.classify(gId)).toBe(id))

  it.each([
    ['GoldenEffigie1', 'golden-effigy'], ['GoldenEffigie9', 'golden-effigy'],
    ['GoldenToxicityEffigie3', 'toxic-effigy'], ['StarformEffigie6', 'starform-effigy'],
    ['AnimalEffigie10', 'animal-effigy'], ['Poster13', 'poster'], ['WreckEntryLocked5', 'entry-console'],
    ['LarvaeBase2', 'larvae'], ['Butterfly11Larvae', 'larvae'], ['Fish15Eggs', 'fish-eggs'], ['Frog16Eggs', 'frog-eggs'],
  ])('regex category: %s -> %s', (gId, id) => expect(compiled.classify(gId)).toBe(id))

  it.each(['Poster', 'Poster1x', 'xPoster1', 'GoldenEffigie', 'Ice', 'BlazarQuartz', 'Tungsten', 'Superalloy', '', 'iron'])(
    'leaves %j as other (exact, case-sensitive matching)',
    (gId) => expect(compiled.classify(gId)).toBe(OTHER_ID),
  )

  it('appends the implicit other category and group', () => {
    const last = compiled.categories.at(-1)
    expect(last).toEqual({ id: 'other', label: 'Other', group: 'other', color: '#8b949e', match: [] })
    expect(compiled.groups.map((g) => g.id)).toEqual(
      ['ore', 'crystal', 'organic', 'vein', 'container', 'wreck', 'collectible', 'life', 'other'])
    expect(compiled.byId.get('other')).toBe(last)
    expect(compiled.byId.get('iron')).toMatchObject({ label: 'Iron', group: 'ore' })
    expect(compiled.byId.size).toBe(compiled.categories.length)
  })

  it('uses our own labels for the misspelled gIds', () => {
    expect(compiled.byId.get('uranium').label).toBe('Uranium')
    expect(compiled.byId.get('blazar-quartz').label).toBe('Blazar quartz')
  })

  // Small markers on the dark (#0e1116) map: every colour must stand out from the background,
  // and colours in one group (shown together) must be told apart.
  it('has readable, distinct colours', () => {
    const bg = luminance('#0e1116')
    for (const c of json.categories) expect((luminance(c.color) + 0.05) / (bg + 0.05), c.id).toBeGreaterThanOrEqual(4.5)
    const colors = json.categories.map((c) => c.color.toLowerCase())
    expect(new Set(colors).size).toBe(colors.length)
    for (const g of json.groups) {
      const cs = json.categories.filter((c) => c.group === g.id)
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          expect(oklabDistance(cs[i].color, cs[j].color), `${cs[i].id} vs ${cs[j].id}`).toBeGreaterThanOrEqual(0.07)
        }
      }
    }
  })

  it('round-trips through the generated index shape (other included)', () => {
    const again = compileCategories({ format: 'pcmap-index/1', groups: compiled.groups, categories: compiled.categories })
    expect(again.categories).toEqual(compiled.categories)
    expect(again.groups).toEqual(compiled.groups)
    expect(again.classify('Uranim')).toBe('uranium')
  })
})

describe('compileCategories', () => {
  const base = () => ({
    format: 'pcmap-categories/1',
    groups: [{ id: 'g', label: 'G' }],
    categories: [{ id: 'a', label: 'A', group: 'g', color: '#112233', match: ['A'] }],
  })
  const withCats = (...categories) => ({ ...base(), categories })
  afterEach(() => vi.restoreAllMocks())

  it('first match in file order wins, across exact and regex entries', () => {
    const c = compileCategories(withCats(
      { id: 'early-regex', label: 'x', group: 'g', color: '#111111', match: ['/^Iron/'] },
      { id: 'late-exact', label: 'x', group: 'g', color: '#222222', match: ['Iron', 'Cobalt'] },
      { id: 'late-regex', label: 'x', group: 'g', color: '#333333', match: ['/^Co/'] },
    ))
    expect(c.classify('Iron')).toBe('early-regex')
    expect(c.classify('IronX')).toBe('early-regex')
    expect(c.classify('Cobalt')).toBe('late-exact')
    expect(c.classify('Copper')).toBe('late-regex')
    expect(c.classify('Zinc')).toBe('other')
  })

  it('supports regex flags i, m, s, u', () => {
    const c = compileCategories(withCats({ id: 'a', label: 'A', group: 'g', color: '#112233', match: ['/^poster\\d+$/i'] }))
    expect(c.classify('Poster3')).toBe('a')
  })

  it('memoizes classify', () => {
    const c = compileCategories(withCats({ id: 'a', label: 'A', group: 'g', color: '#112233', match: ['/^A/', '/^B/'] }))
    const spy = vi.spyOn(RegExp.prototype, 'test')
    expect(c.classify('Zed')).toBe('other')
    const first = spy.mock.calls.length
    expect(first).toBeGreaterThan(0)
    expect(c.classify('Zed')).toBe('other')
    expect(spy.mock.calls.length).toBe(first)
  })

  it('returns other for non-string input', () => {
    const c = compileCategories(base())
    expect(c.classify(undefined)).toBe('other')
    expect(c.classify(42)).toBe('other')
  })

  it('keeps a declared other group and does not duplicate it', () => {
    const c = compileCategories({ ...base(), groups: [{ id: 'other', label: 'Misc' }, { id: 'g', label: 'G' }] })
    expect(c.groups).toEqual([{ id: 'other', label: 'Misc' }, { id: 'g', label: 'G' }])
  })

  it.each([
    ['a non-object', null, /expected a JSON object/],
    ['a wrong format', { ...base(), format: 'pcmap-categories/2' }, /format must be one of/],
    ['missing groups', { format: 'pcmap-categories/1', categories: [] }, /groups must be an array/],
    ['a duplicate group', { ...base(), groups: [{ id: 'g', label: 'G' }, { id: 'g', label: 'H' }] }, /duplicate group id 'g'/],
    ['a group without label', { ...base(), groups: [{ id: 'g' }] }, /groups\[0\] 'g': label must be a non-empty string/],
    ['a duplicate category', withCats(base().categories[0], { ...base().categories[0], match: ['B'] }),
      /categories\[1\] 'a': duplicate category id/],
    ['an unknown group', withCats({ ...base().categories[0], group: 'nope' }), /group "nope" is not declared/],
    ['a bad colour', withCats({ ...base().categories[0], color: 'red' }), /color must be #rrggbb \(got "red"\)/],
    ['a short colour', withCats({ ...base().categories[0], color: '#fff' }), /color must be #rrggbb/],
    ['a non-slug id', withCats({ ...base().categories[0], id: 'Iron Ore' }), /id must be a lowercase slug/],
    ['a regex that does not compile', withCats({ ...base().categories[0], match: ['/^(Iron$/'] }), /regex does not compile/],
    ['a stateful regex flag', withCats({ ...base().categories[0], match: ['/^Iron$/g'] }), /flags from \[imsu\]/],
    ['an empty match list', withCats({ ...base().categories[0], match: [] }), /match must not be empty/],
    ['a non-array match', withCats({ ...base().categories[0], match: 'A' }), /match must be an array/],
    ['an exact gId claimed twice', withCats(base().categories[0], { ...base().categories[0], id: 'b', color: '#445566' }),
      /gId 'A' is already matched exactly by category 'a'/],
    ['an other category with matches', withCats({ id: 'other', label: 'O', group: 'g', color: '#112233', match: ['X'] }),
      /fallback category cannot have match entries/],
  ])('throws on %s', (_, input, re) => {
    expect(() => compileCategories(input)).toThrow(re)
  })

  it('reports every problem at once', () => {
    let message = ''
    try {
      compileCategories(withCats(
        { id: 'a', label: '', group: 'g', color: '#112233', match: ['A'] },
        { id: 'b', label: 'B', group: 'zz', color: '#nothex', match: ['B'] },
      ))
    } catch (e) {
      message = e.message
    }
    expect(message).toMatch(/^invalid categories: 3 problem\(s\)/)
    expect(message).toMatch(/'a': label/)
    expect(message).toMatch(/'b': group "zz"/)
    expect(message).toMatch(/'b': color/)
  })
})

function channels(hex) {
  return [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
}
function luminance(hex) {
  const [r, g, b] = channels(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function oklab(hex) {
  const [r, g, b] = channels(hex)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
function oklabDistance(a, b) {
  const [p, q] = [oklab(a), oklab(b)]
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}
