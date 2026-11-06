import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BuildDataError, buildData, revOf } from '../scripts/build-data.mjs'
import { buildHeights } from './fixtures/heights-builder.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'dumps')
// Most tests build without relief, so their output does not depend on data/heights.
const NO_HEIGHTS = path.join(ROOT, 'test', 'fixtures', 'heights', 'empty')
const SCRIPT = path.join(ROOT, 'scripts', 'build-data.mjs')
const SLUGS = ['prime', 'humble', 'selenea', 'aqualis', 'toxicity', 'skeo']

const temps = []
const tmp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pcmap-build-data-'))
  temps.push(dir)
  return dir
}
afterAll(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))))

const quiet = { log: () => {} }
const build = async (dumpsDir, extra = {}) => {
  const outDir = path.join(await tmp(), 'out')
  const result = await buildData({ rootDir: ROOT, dumpsDir, heightsDir: NO_HEIGHTS, outDir, ...quiet, ...extra })
  return { outDir, result }
}
const readJson = async (dir, file) => JSON.parse(await readFile(path.join(dir, file), 'utf8'))
const readAll = async (dir) => {
  const files = (await readdir(dir)).sort()
  return Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(path.join(dir, f))])))
}
const failure = async (promise) => {
  try {
    await promise
  } catch (e) {
    return e
  }
  throw new Error('expected buildData to fail')
}

describe('buildData on the synthetic fixtures', () => {
  let outDir, result, index, prime
  beforeAll(async () => {
    ;({ outDir, result } = await build(path.join(FIXTURES, 'valid')))
    index = await readJson(outDir, 'index.json')
    prime = await readJson(outDir, 'prime.json')
  })

  it('writes index.json and one file per world, empty worlds included', async () => {
    expect((await readdir(outDir)).sort()).toEqual(['index.json', ...SLUGS.map((s) => `${s}.json`)].sort())
    for (const slug of ['aqualis', 'toxicity', 'skeo']) {
      expect(await readJson(outDir, `${slug}.json`)).toMatchObject({ format: 'pcmap-world/1', gids: [], points: [] })
    }
  })

  it('produces exact counts per world', () => {
    expect(index.worlds.map((w) => [w.id, w.count])).toEqual([
      ['Prime', 6], ['Humble', 2], ['Selenea', 1], ['Aqualis', 0], ['Toxicity', 0], ['Skeo', 0],
    ])
    const p = result.worlds[0]
    expect(p.dumps).toEqual(['test/fixtures/dumps/valid/Prime/01-dumper.json', 'test/fixtures/dumps/valid/Prime/02-extra.csv'])
    expect(p.stats).toEqual({ input: 12, unique: 7, duplicates: 5, conflicts: 1 })
    expect(p.runtimeExcluded).toBe(1)
    expect(p.unknownGids).toEqual([['FakeGizmo', 1]])
    expect(result.worlds[1]).toMatchObject({ id: 'Humble', dumps: ['test/fixtures/dumps/valid/Humble/a.csv'], unknownGids: [] })
    expect(result.worlds[3]).toMatchObject({ id: 'Aqualis', count: 0, dumps: [], unknownGids: [] })
  })

  it('writes the pcmap-world/1 contents', async () => {
    expect(Object.keys(prime)).toEqual(['format', 'world', 'rev', 'gameVersion', 'randomizeMineables', 'sources', 'gids', 'points'])
    expect(prime).toMatchObject({
      world: 'Prime', gameVersion: '0.0-synthetic', randomizeMineables: false, sources: ['synthetic-fixture 1'],
      gids: ['Cobalt', 'FakeGizmo', 'Fish3Eggs', 'GoldenEffigie1', 'Iron', 'Uranim'],
      points: [
        [0, 110, 10, -200, 100000002],
        [1, 1, 2, 3, 0],
        [2, 50, 1, 50, 100000004],
        [3, -300.3, 5, 400, 100000003],
        [4, 100, 10, 200, 100000001],
        [5, 0, 20, 0, 0],
      ],
    })
    expect(await readJson(outDir, 'humble.json')).toMatchObject({
      world: 'Humble', gameVersion: null, randomizeMineables: null, sources: [],
      gids: ['Container2', 'LarvaeBase1'], points: [[0, 7, 8, 9, 100000102], [1, -10.2, 3, -20.7, 100000101]],
    })
  })

  it('writes the pcmap-index/1 contents', () => {
    expect(index.format).toBe('pcmap-index/1')
    expect(index.worlds[0]).toEqual({
      id: 'Prime', slug: 'prime', name: 'Prime', kind: 'planet', access: 'base', hash: -1140328421,
      frame: [-2000, -2000, 3000, 3000], extent: [-300.3, -200, 110, 400], count: 6, file: 'prime.json',
      rev: prime.rev, basemap: null,
    })
    expect(index.worlds[3]).toMatchObject({ id: 'Aqualis', extent: null, count: 0, file: 'aqualis.json' })
    expect(index.categories.at(-1)).toMatchObject({ id: 'other', group: 'other' })
    expect(index.groups.at(-1)).toEqual({ id: 'other', label: 'Other' })
  })

  it('sets rev to the first 12 hex digits of sha256 of the file without rev', async () => {
    for (const w of index.worlds) {
      const data = await readJson(outDir, w.file)
      const { rev, ...rest } = data
      expect(rev).toMatch(/^[0-9a-f]{12}$/)
      expect(rev).toBe(w.rev)
      expect(createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 12)).toBe(rev)
      expect(revOf(rest)).toBe(rev)
    }
  })

  it('reports merge and validation warnings', () => {
    const all = result.warnings.join('\n')
    expect(all).toMatch(/01-dumper\.json: dropped 1 object\(s\) at the in-space position/)
    expect(all).toMatch(/Prime: conflict on id:100000003: kept GoldenEffigie1 .* dropped Titanium/)
    expect(all).not.toMatch(/README|ignored\.json/)
    expect(result.alerts).toEqual([])
  })

  it('is byte-deterministic', async () => {
    const again = await build(path.join(FIXTURES, 'valid'))
    expect(await readAll(again.outDir)).toEqual(await readAll(outDir))
  })

  it('keeps runtime objects with includeRuntime', async () => {
    const { result: r } = await build(path.join(FIXTURES, 'valid'), { includeRuntime: true })
    expect(r.worlds[0]).toMatchObject({ count: 7, runtimeExcluded: 0 })
  })

  it('logs a report', async () => {
    const lines = []
    await build(path.join(FIXTURES, 'valid'), { log: (l) => lines.push(l) })
    const text = lines.join('\n')
    expect(text).toMatch(/^build-data: 6 world\(s\), 4 dump file\(s\) from test\/fixtures\/dumps\/valid -> /)
    expect(text).toMatch(/Prime +6 point\(s\) +rev [0-9a-f]{12} +prime\.json +\[2 dump\(s\): 12 in, 5 duplicate\(s\), 1 conflict\(s\), 1 runtime excluded\]/)
    expect(text).toMatch(/Aqualis +0 point\(s\).*\[no dumps\]/)
    expect(text).toMatch(/gIds with no category[^\n]*\n {2}Prime: FakeGizmo x1/)
    expect(text).toMatch(/warnings \(\d+\):/)
  })
})

describe('buildData changes and failures', () => {
  it('changes rev when data changes, and only for that world', async () => {
    const dumps = path.join(await tmp(), 'dumps')
    await cp(path.join(FIXTURES, 'valid'), dumps, { recursive: true })
    const before = (await build(dumps)).result.worlds
    await writeFile(path.join(dumps, 'Humble', 'a.csv'), '\n100000103,Fish1Eggs,1,1,1\n', { flag: 'a' })
    const after = (await build(dumps)).result.worlds
    expect(after[1].count).toBe(before[1].count + 1)
    expect(after[1].rev).not.toBe(before[1].rev)
    expect(after[0].rev).toBe(before[0].rev)
  })

  it('recreates the output directory, deleting stale outputs and OS metadata files', async () => {
    const outDir = path.join(await tmp(), 'out')
    await mkdir(outDir)
    await writeFile(path.join(outDir, 'stale.json'), '{"format":"pcmap-world/1"}')
    for (const junk of ['.DS_Store', '._prime.json', 'Thumbs.db', 'desktop.ini']) await writeFile(path.join(outDir, junk), 'x')
    await buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), heightsDir: NO_HEIGHTS, outDir, ...quiet })
    expect((await readdir(outDir)).sort()).toEqual(['index.json', ...SLUGS.map((s) => `${s}.json`)].sort())
  })

  it('treats a missing default dumps directory as empty', async () => {
    const root = await tmp()
    await mkdir(path.join(root, 'data'))
    for (const f of ['worlds.json', 'categories.json']) await cp(path.join(ROOT, 'data', f), path.join(root, 'data', f))
    const result = await buildData({ rootDir: root, outDir: path.join(root, 'out'), ...quiet })
    expect(result.worlds.map((w) => w.count)).toEqual([0, 0, 0, 0, 0, 0])
    expect(result.warnings).toEqual(['data/dumps: no dumps directory; every world will be empty'])
  })

  it('fails, and writes nothing, when an explicit dumps directory is missing or not a directory', async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, 'a-file'), 'x')
    for (const [name, problem] of [['does-not-exist', 'does not exist'], ['a-file', 'is not a directory']]) {
      const outDir = path.join(dir, 'out')
      const e = await failure(buildData({ rootDir: ROOT, dumpsDir: path.join(dir, name), outDir, ...quiet }))
      expect(e).toBeInstanceOf(BuildDataError)
      expect(e.errors).toEqual([`${path.join(dir, name)}: dumps directory ${problem}`])
      await expect(readdir(outDir)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects a dump whose planet disagrees with its folder, and writes nothing', async () => {
    const outDir = path.join(await tmp(), 'out')
    await mkdir(outDir)
    const previous = '{"format":"pcmap-world/1","untouched":true}'
    await writeFile(path.join(outDir, 'previous.json'), previous)
    const e = await failure(buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'mismatch'), outDir, ...quiet }))
    expect(e).toBeInstanceOf(BuildDataError)
    expect(e.errors).toEqual([
      "test/fixtures/dumps/mismatch/Prime/wrong-planet.json: planet 'Humble' does not match its folder 'Prime' (Prime)",
    ])
    expect(await readdir(outDir)).toEqual(['previous.json'])
    expect(await readFile(path.join(outDir, 'previous.json'), 'utf8')).toBe(previous)
  })

  it('reports every error at once', async () => {
    const e = await failure(build(path.join(FIXTURES, 'bad')))
    const at = 'test/fixtures/dumps/bad'
    expect(e.errors).toEqual([
      `${at}/Atlantis/x.csv: folder 'Atlantis' is not a world id (expected one of Prime, Humble, Selenea, Aqualis, Toxicity, Skeo)`,
      `${at}/Prime/bad-objects.json: objects[0]: id must be a non-negative integer or null (got -1); ` +
        'pos must be [x, y, z] finite numbers or an "x,y,z" string (got [1,2])',
      `${at}/Prime/bad-objects.json: 1 of 1 object(s) are invalid`,
      expect.stringMatching(new RegExp(`^${at}/Prime/broken\\.json: invalid JSON`)),
      `${at}/lowercase.json: unknown planet 'prime' (did you mean 'Prime'? planet ids are case-sensitive)`,
      `${at}/nowhere.json: unknown planet 'Nowhere' (known: Prime, Humble, Selenea, Aqualis, Toxicity, Skeo)`,
    ])
    expect(e.message).toMatch(/^build-data failed with 6 error\(s\):/)
  })

  it('raises a loud alert for randomizeMineables dumps', async () => {
    const dumps = path.join(await tmp(), 'dumps')
    await mkdir(path.join(dumps, 'Skeo'), { recursive: true })
    await writeFile(path.join(dumps, 'Skeo', 'shuffled.json'), JSON.stringify({
      format: 'pcmap-dump/1', planet: 'Skeo', randomizeMineables: true,
      objects: [{ id: 100000001, gId: 'Iron', pos: [1, 2, 3] }],
    }))
    const { outDir, result } = await build(dumps)
    expect(result.alerts[0]).toMatch(/^!!! WARNING: randomizeMineables is TRUE/)
    expect(result.alerts.at(-1)).toMatch(/Skeo\/shuffled\.json$/)
    expect((await readJson(outDir, 'skeo.json')).randomizeMineables).toBe(true)
  })

  it('validates worlds.json and categories.json from rootDir', async () => {
    const root = await tmp()
    await mkdir(path.join(root, 'data'))
    const worlds = JSON.parse(await readFile(path.join(ROOT, 'data', 'worlds.json'), 'utf8'))
    worlds.worlds[0].hash = 1
    await writeFile(path.join(root, 'data', 'worlds.json'), JSON.stringify(worlds))
    await writeFile(path.join(root, 'data', 'categories.json'), '{"format":"pcmap-categories/1","groups":[]}')
    const e = await failure(buildData({ rootDir: root, ...quiet }))
    expect(e.errors).toEqual([
      `data/worlds.json: worlds[0] 'Prime': hash must be planetHash("Prime") = -1140328421 (got 1)`,
      expect.stringMatching(/^data\/categories\.json: invalid categories: 1 problem\(s\)\n {2}- categories must be an array/),
    ])
  })

  it('refuses an output directory that would delete sources', async () => {
    const root = await tmp()
    await mkdir(path.join(root, 'data'))
    await cp(path.join(ROOT, 'data', 'worlds.json'), path.join(root, 'data', 'worlds.json'))
    await cp(path.join(ROOT, 'data', 'categories.json'), path.join(root, 'data', 'categories.json'))
    await writeFile(path.join(root, 'marker'), 'x')
    const dump = path.join(root, 'data', 'dumps', 'Prime', 'Prime-20261104.json')
    await mkdir(path.dirname(dump), { recursive: true })
    await cp(path.join(FIXTURES, 'valid', 'Prime', '01-dumper.json'), dump)
    for (const outDir of [root, path.join(root, 'data'), path.join(root, 'data', 'dumps')]) {
      const e = await failure(buildData({ rootDir: root, outDir, ...quiet }))
      expect(e.errors.join('\n')).toMatch(/refusing to delete/)
    }
    // Inside the sources: a world dump folder (even an empty or missing one) and data/ itself.
    for (const [outDir, inside] of [['data/dumps/Prime', 'dumps'], ['data/dumps/Skeo', 'dumps'], ['data/out', 'data/ sources']]) {
      const e = await failure(buildData({ rootDir: root, outDir, ...quiet }))
      expect(e.errors).toEqual([`output directory ${path.join(root, outDir)}: refusing to delete a directory inside the ${inside}`])
    }
    expect(await readFile(path.join(root, 'marker'), 'utf8')).toBe('x')
    expect(await readdir(path.dirname(dump))).toEqual(['Prime-20261104.json'])
    expect(await readdir(path.join(root, 'data', 'dumps'))).toEqual(['Prime'])
  })

  it('refuses an output directory inside an explicit dumps directory outside data/', async () => {
    const dumps = path.join(await tmp(), 'pcmap-dumps')
    await mkdir(path.join(dumps, 'Prime'), { recursive: true })
    await cp(path.join(FIXTURES, 'valid', 'Prime', '01-dumper.json'), path.join(dumps, 'Prime', 'a.json'))
    const outDir = path.join(dumps, 'out')
    for (const exists of [false, true]) {
      if (exists) await mkdir(outDir)
      const e = await failure(buildData({ rootDir: ROOT, dumpsDir: dumps, outDir, ...quiet }))
      expect(e.errors).toEqual([`output directory ${outDir}: refusing to delete a directory inside the dumps`])
      expect((await readdir(dumps)).sort()).toEqual(exists ? ['Prime', 'out'] : ['Prime'])
      if (exists) expect(await readdir(outDir)).toEqual([])
    }
  })

  it('rebuilds over its own older-format or damaged outputs', async () => {
    const outDir = path.join(await tmp(), 'out')
    await mkdir(outDir)
    await writeFile(path.join(outDir, 'index.json'), '{"format":"pcmap-index/0","worlds":[]}')
    await writeFile(path.join(outDir, 'old-world.json'), '{"format":"pcmap-world/0"}')
    await writeFile(path.join(outDir, 'future.json'), '{"format":"pcmap-world/12"}')
    await writeFile(path.join(outDir, 'prime.json'), '')
    await writeFile(path.join(outDir, 'skeo.json'), '{"format":"pcmap-world/1","world":"Sk')
    await buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), outDir, ...quiet })
    expect((await readdir(outDir)).sort()).toEqual(['index.json', ...SLUGS.map((s) => `${s}.json`)].sort())
    expect(await readJson(outDir, 'prime.json')).toMatchObject({ format: 'pcmap-world/1', world: 'Prime' })
  })

  it('still refuses dumps, other JSON, and damaged files it would not write, even under generated names', async () => {
    const outDir = path.join(await tmp(), 'out')
    await mkdir(outDir)
    const files = {
      'prime.json': await readFile(path.join(FIXTURES, 'valid', 'Prime', '01-dumper.json'), 'utf8'),
      'humble.json': '{"name":"no format tag"}',
      'notes.json': '',
      'skeo.json': '{"format":"pcmap-worlds/1"}',
    }
    for (const [f, text] of Object.entries(files)) await writeFile(path.join(outDir, f), text)
    const e = await failure(buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), outDir, ...quiet }))
    expect(e.errors).toEqual([`output directory ${outDir}: refusing to delete it: it holds entries build-data does not ` +
      'write (humble.json, notes.json, prime.json, ...); some are pcmap-dump/1 dumps; choose another --out'])
    for (const [f, text] of Object.entries(files)) expect(await readFile(path.join(outDir, f), 'utf8')).toBe(text)
  })

  it('refuses to recreate an output directory holding files it did not write', async () => {
    const outDir = path.join(await tmp(), 'src')
    await mkdir(path.join(outDir, 'sub'), { recursive: true })
    await writeFile(path.join(outDir, 'main.js'), '// precious')
    await writeFile(path.join(outDir, 'package.json'), '{"name":"precious"}')
    const e = await failure(buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), outDir, ...quiet }))
    expect(e.errors).toEqual([expect.stringMatching(
      /refusing to delete it: it holds entries build-data does not write \(main\.js, package\.json, sub\); empty it/)])
    expect(await readFile(path.join(outDir, 'main.js'), 'utf8')).toBe('// precious')
  })

  it('refuses an output directory holding dumps (e.g. the dumper folder passed as --out)', async () => {
    const outDir = path.join(await tmp(), 'pcmap-dumps')
    await mkdir(outDir)
    const dump = path.join(outDir, 'Prime-20261104-201500.json')
    await cp(path.join(FIXTURES, 'valid', 'Prime', '01-dumper.json'), dump)
    const before = await readFile(dump)
    const e = await failure(buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), outDir, ...quiet }))
    expect(e.errors).toEqual([expect.stringMatching(
      /\(Prime-20261104-201500\.json\); some are pcmap-dump\/1 dumps; choose another --out$/)])
    expect(await readdir(outDir)).toEqual(['Prime-20261104-201500.json'])
    expect(await readFile(dump)).toEqual(before)
  })
})

describe('heightmaps', () => {
  const heightsDir = async (files) => {
    const dir = path.join(await tmp(), 'heights')
    for (const [rel, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
      await writeFile(path.join(dir, rel), bytes)
    }
    return dir
  }
  const hill = (x, z) => 30 * Math.exp(-((x - 500) ** 2 + (z - 500) ** 2) / 2e5)
  const prime = () => buildHeights({ minX: -2500, minZ: -2500, step: 50, width: 121, height: 121, terrain: hill })

  it('renders a basemap for a world with a heightmap and points index.json at it', async () => {
    const dir = await heightsDir({ 'Prime/Prime-1.heights.gz': prime() })
    const lines = []
    const { outDir } = await build(path.join(FIXTURES, 'valid'), { heightsDir: dir, log: (l) => lines.push(l) })
    const index = await readJson(outDir, 'index.json')
    const bm = index.worlds[0].basemap
    expect(bm).toMatchObject({ type: 'image', url: expect.stringMatching(/^data\/basemaps\/prime-[0-9a-f]{12}\.png$/) })
    // Frame [-2000, 3000] grown by 20% = [-3000, 4000], clipped to the grid's [-2500, 3500] cell centres.
    expect(bm.bounds).toEqual([-2525, -2525, 3525, 3525])
    expect(index.worlds.slice(1).map((w) => w.basemap)).toEqual([null, null, null, null, null])
    const png = await readFile(path.join(outDir, bm.url.slice('data/'.length)))
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    expect(await readdir(path.join(outDir, 'basemaps'))).toEqual([path.basename(bm.url)])
    expect(lines.join('\n')).toMatch(/basemap Prime: basemaps\/prime-[0-9a-f]{12}\.png 121x121 px at 50 m/)
    // Rebuilding over its own output (a basemaps/ folder included) works and is byte-identical.
    await buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), heightsDir: dir, outDir, ...quiet })
    expect(await readFile(path.join(outDir, bm.url.slice('data/'.length)))).toEqual(png)
  })

  it('uses the last heightmap per world and warns about the others', async () => {
    const dir = await heightsDir({
      'Prime/Prime-1.heights.gz': prime(),
      'Prime/Prime-2.heights.gz': buildHeights({ minX: -2500, minZ: -2500, step: 50, width: 121, height: 121, terrain: () => 1 }),
    })
    const { result } = await build(path.join(FIXTURES, 'valid'), { heightsDir: dir })
    expect(result.warnings).toContainEqual(expect.stringMatching(/Prime: several heightmaps; using .*Prime-2\.heights\.gz/))
  })

  it('keeps a basemap configured in worlds.json over a heightmap', async () => {
    const root = await tmp()
    await mkdir(path.join(root, 'data'))
    await cp(path.join(ROOT, 'data', 'categories.json'), path.join(root, 'data', 'categories.json'))
    const worlds = JSON.parse(await readFile(path.join(ROOT, 'data', 'worlds.json'), 'utf8'))
    worlds.worlds[0].basemap = { type: 'image', url: 'art/prime.png', bounds: [0, 0, 10, 10] }
    await writeFile(path.join(root, 'data', 'worlds.json'), JSON.stringify(worlds))
    const dir = await heightsDir({ 'Prime/a.heights.gz': prime() })
    const outDir = path.join(root, 'out')
    await buildData({ rootDir: root, heightsDir: dir, outDir, ...quiet })
    expect((await readJson(outDir, 'index.json')).worlds[0].basemap.url).toBe('art/prime.png')
    expect(await readdir(outDir)).not.toContain('basemaps')
  })

  it('fails, writing nothing, on a bad, misplaced or mismatched heightmap', async () => {
    const dir = await heightsDir({
      'Prime/broken.heights.gz': Buffer.from('not gzip'),
      'Humble/wrong.heights.gz': prime(),
      'loose.heights.gz': prime(),
      'Prime/notes.txt': 'x',
    })
    const outDir = path.join(await tmp(), 'out')
    const e = await failure(buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), heightsDir: dir, outDir, ...quiet }))
    expect(e).toBeInstanceOf(BuildDataError)
    expect(e.errors).toEqual([
      expect.stringMatching(/Humble\/wrong\.heights\.gz: planet 'Prime' does not match its folder 'Humble'/),
      expect.stringMatching(/Prime\/broken\.heights\.gz: not a gzip file/),
      expect.stringMatching(/loose\.heights\.gz: heightmaps go in data\/heights\/<WorldId>\//),
    ])
    expect(e.warnings).toContainEqual(expect.stringMatching(/notes\.txt: ignored/))
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('treats a missing default heights directory as no relief, and a missing explicit one as an error', async () => {
    const root = await tmp()
    await mkdir(path.join(root, 'data'))
    for (const f of ['worlds.json', 'categories.json']) await cp(path.join(ROOT, 'data', f), path.join(root, 'data', f))
    const result = await buildData({ rootDir: root, outDir: path.join(root, 'out'), ...quiet })
    expect(result.index.worlds.every((w) => w.basemap === null)).toBe(true)
    const e = await failure(buildData({ rootDir: root, heightsDir: path.join(root, 'typo'), outDir: path.join(root, 'out'), ...quiet }))
    expect(e.errors).toEqual([expect.stringMatching(/typo: heights directory does not exist/)])
  })

  it('refuses an output directory that contains the heights directory', async () => {
    const root = await tmp()
    const dir = path.join(root, 'out', 'heights')
    await mkdir(dir, { recursive: true })
    const e = await failure(buildData({ rootDir: ROOT, dumpsDir: path.join(FIXTURES, 'valid'), heightsDir: dir, outDir: path.join(root, 'out'), ...quiet }))
    expect(e.errors).toContainEqual(expect.stringMatching(/contains the heights/))
  })
})

describe('CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })

  it('builds with --dumps/--out and prints nothing with --quiet', async () => {
    const out = path.join(await tmp(), 'out')
    const r = run('--dumps', path.join(FIXTURES, 'valid'), '--out', out, '--quiet')
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
    expect((await readJson(out, 'index.json')).worlds.map((w) => w.count)).toEqual([6, 2, 1, 0, 0, 0])
  })

  it('prints the report and honours --include-runtime', async () => {
    const out = path.join(await tmp(), 'out')
    const r = run(`--dumps=${path.join(FIXTURES, 'valid')}`, `--out=${out}`, '--include-runtime')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Prime +7 point\(s\)/)
  })

  it('exits 1 with every message on errors', async () => {
    const out = path.join(await tmp(), 'out')
    const r = run('--dumps', path.join(FIXTURES, 'bad'), '--out', out, '-q')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/build-data failed with 6 error\(s\)/)
    expect(r.stderr).toMatch(/folder 'Atlantis' is not a world id/)
    expect(r.stderr).toMatch(/unknown planet 'Nowhere'/)
  })

  it('exits 1 under --quiet when --dumps does not exist', async () => {
    const dir = await tmp()
    const r = run('--dumps', path.join(dir, 'typo-missing'), '--out', path.join(dir, 'out'), '-q')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/typo-missing: dumps directory does not exist/)
    expect(await readdir(dir)).toEqual([])
  })

  it('exits 2 on unknown flags', () => {
    const r = run('--frobnicate')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/usage: node scripts\/build-data\.mjs/)
  })

  it('builds from the real data/dumps (six worlds)', async () => {
    const out = path.join(await tmp(), 'out')
    const r = run('--out', out, '-q')
    expect(r.status).toBe(0)
    const index = await readJson(out, 'index.json')
    expect(index.worlds.map((w) => w.file)).toEqual(SLUGS.map((s) => `${s}.json`))
  })
})

describe('published sources (data/dumps)', () => {
  it('build cleanly from vanilla dumps, with every gId in a category', async () => {
    const { result } = await build(path.join(ROOT, 'data', 'dumps'))
    expect(result.alerts).toEqual([])
    for (const w of result.worlds) expect([w.id, w.unknownGids]).toEqual([w.id, []])
  })
})
