#!/usr/bin/env node
// Data pipeline: data/worlds.json + data/categories.json + data/dumps/** -> public/data/
//
//   node scripts/build-data.mjs [--dumps <dir>] [--out <dir>] [--include-runtime] [--quiet]
//
// Validates every source, merges and de-duplicates the dumps per world, and writes index.json
// (pcmap-index/1) plus one <slug>.json (pcmap-world/1) per world, including worlds with no data.
// Nothing is written when any error is found. Output is byte-deterministic for the same inputs.
// Formats: docs/ARCHITECTURE.md.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { OTHER_ID, compileCategories } from '../src/lib/categories.js'
import { DUMP_FORMAT, mergeDumps, parseDumpText, toWorldData, validateDump } from '../src/lib/dump.js'
import { RUNTIME_ID_MIN, planetHash } from '../src/lib/planets.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORLDS_FORMAT = 'pcmap-worlds/1'
const INDEX_FORMAT = 'pcmap-index/1'
const KINDS = ['planet', 'moon']
const ACCESS = ['base', 'dlc', 'free-update']
const WORLD_ID_RE = /^[A-Za-z][A-Za-z0-9]*$/
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DUMP_EXT_RE = /\.(json|csv)$/i
// OS metadata files that may appear in the output directory; deleting them loses nothing.
const OS_JUNK_RE = /^(\.DS_Store|\._.+|Thumbs\.db|desktop\.ini)$/i
// What build-data writes, in any version, so a format bump can rebuild over older output.
const OUTPUT_FORMAT_RE = /^pcmap-(index|world)\/\d+$/
const FRAME_LIMIT = 1e6

/** Every problem found, so a maintainer can fix them all in one go. */
export class BuildDataError extends Error {
  /** @param {string[]} errors @param {string[]} warnings */
  constructor(errors, warnings) {
    super(`build-data failed with ${errors.length} error(s):\n  - ${errors.join('\n  - ')}`)
    this.name = 'BuildDataError'
    this.errors = errors
    this.warnings = warnings
  }
}

/**
 * @typedef {[number, number, number, number]} Frame [minX, minZ, maxX, maxZ]
 * @typedef {{ type: 'image', url: string, bounds: Frame }} Basemap
 * @typedef {{ id: string, slug: string, name: string, kind: string, access: string, hash: number,
 *   frame: Frame, basemap?: Basemap|null }} World
 * @typedef {object} WorldReport
 * @property {string} id
 * @property {string} file
 * @property {number} count published points
 * @property {string} rev
 * @property {string[]} dumps dump files merged into this world
 * @property {{ input: number, unique: number, duplicates: number, conflicts: number }} stats
 * @property {number} runtimeExcluded objects left out because id >= RUNTIME_ID_MIN
 * @property {[string, number][]} unknownGids gIds that classify as 'other', with point counts
 * @typedef {object} BuildResult
 * @property {string} outDir
 * @property {object} index the written index.json
 * @property {WorldReport[]} worlds
 * @property {string[]} warnings
 * @property {string[]} alerts loud warnings (randomizeMineables dumps)
 */

/**
 * Check `data/worlds.json`.
 * @param {unknown} json
 * @returns {{ worlds: World[], errors: string[] }} `worlds` is empty when there are errors
 */
export function validateWorlds(json) {
  /** @type {string[]} */
  const errors = []
  if (!isObject(json)) return { worlds: [], errors: ['expected a JSON object'] }
  if (json.format !== WORLDS_FORMAT) errors.push(`format must be "${WORLDS_FORMAT}" (got ${JSON.stringify(json.format)})`)
  if (!Array.isArray(json.worlds) || !json.worlds.length) {
    errors.push('worlds must be a non-empty array')
    return { worlds: [], errors }
  }
  const ids = new Set()
  const slugs = new Set()
  json.worlds.forEach((/** @type {any} */ w, /** @type {number} */ i) => {
    const at = `worlds[${i}]` + (typeof w?.id === 'string' ? ` '${w.id}'` : '')
    if (!isObject(w)) return errors.push(`${at}: must be an object`)
    if (typeof w.id !== 'string' || !WORLD_ID_RE.test(w.id)) {
      errors.push(`${at}: id must be an alphanumeric world id such as "Prime" (got ${JSON.stringify(w.id)})`)
    } else {
      // Unique ignoring case too: ids name folders under data/dumps/, and some file systems fold case.
      if (ids.has(w.id.toLowerCase())) errors.push(`${at}: duplicate id (ids must be unique ignoring case)`)
      ids.add(w.id.toLowerCase())
      const expected = planetHash(w.id)
      if (w.hash !== expected) errors.push(`${at}: hash must be planetHash("${w.id}") = ${expected} (got ${JSON.stringify(w.hash)})`)
    }
    if (typeof w.slug !== 'string' || !SLUG_RE.test(w.slug)) {
      errors.push(`${at}: slug must be a lowercase slug (got ${JSON.stringify(w.slug)})`)
    } else {
      if (slugs.has(w.slug)) errors.push(`${at}: duplicate slug '${w.slug}'`)
      slugs.add(w.slug)
    }
    if (typeof w.name !== 'string' || !w.name.trim()) errors.push(`${at}: name must be a non-empty string`)
    if (!KINDS.includes(w.kind)) errors.push(`${at}: kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(w.kind)})`)
    if (!ACCESS.includes(w.access)) errors.push(`${at}: access must be one of ${ACCESS.join(', ')} (got ${JSON.stringify(w.access)})`)
    const frameProblem = checkFrame(w.frame)
    if (frameProblem) errors.push(`${at}: frame ${frameProblem}`)
    if (w.basemap != null) {
      const b = w.basemap
      if (!isObject(b) || b.type !== 'image') errors.push(`${at}: basemap must be { "type": "image", "url", "bounds" }`)
      else {
        if (typeof b.url !== 'string' || !isPlainRelativeUrl(b.url)) {
          errors.push(`${at}: basemap.url must be a relative path without '..', scheme or query (got ${JSON.stringify(b.url)})`)
        }
        const boundsProblem = checkFrame(b.bounds)
        if (boundsProblem) errors.push(`${at}: basemap.bounds ${boundsProblem}`)
      }
    }
  })
  return { worlds: errors.length ? [] : json.worlds, errors }
}

/**
 * sha256 of the world data serialized without `rev`, first 12 hex digits.
 * @param {object} worldDataWithoutRev
 */
export function revOf(worldDataWithoutRev) {
  return createHash('sha256').update(JSON.stringify(worldDataWithoutRev)).digest('hex').slice(0, 12)
}

/**
 * Run the pipeline. Relative paths resolve against `rootDir`. Throws {@link BuildDataError} (and
 * writes nothing) when any source is invalid.
 * @param {object} [opts]
 * @param {string} [opts.rootDir] holds data/worlds.json and data/categories.json (default: this repo)
 * @param {string} [opts.dumpsDir] default `<rootDir>/data/dumps`
 * @param {string} [opts.outDir] default `<rootDir>/public/data`; deleted and recreated
 * @param {boolean} [opts.includeRuntime] keep objects with id >= RUNTIME_ID_MIN
 * @param {(line: string) => void} [opts.log] report sink (default console.log)
 * @returns {Promise<BuildResult>}
 */
export async function buildData({ rootDir = REPO_ROOT, dumpsDir, outDir, includeRuntime = false, log = console.log } = {}) {
  rootDir = path.resolve(rootDir)
  const dumpsAbs = path.resolve(rootDir, dumpsDir ?? 'data/dumps')
  const outAbs = path.resolve(rootDir, outDir ?? 'public/data')
  const show = (/** @type {string} */ p) => {
    const r = path.relative(rootDir, p)
    return !r ? '.' : r.startsWith('..') || path.isAbsolute(r) ? p : r.split(path.sep).join('/')
  }
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {string[]} */
  const alerts = []

  // 1. Hand-maintained sources.
  const worldsJson = await readJson(path.join(rootDir, 'data', 'worlds.json'), 'data/worlds.json', errors)
  const categoriesJson = await readJson(path.join(rootDir, 'data', 'categories.json'), 'data/categories.json', errors)
  /** @type {World[]} */
  let worlds = []
  if (worldsJson !== undefined) {
    const checked = validateWorlds(worldsJson)
    worlds = checked.worlds
    errors.push(...checked.errors.map((e) => `data/worlds.json: ${e}`))
  }
  /** @type {ReturnType<typeof compileCategories>|null} */
  let taxonomy = null
  if (categoriesJson !== undefined) {
    try {
      taxonomy = compileCategories(categoriesJson)
    } catch (e) {
      errors.push(`data/categories.json: ${/** @type {Error} */ (e).message}`)
    }
  }
  const outProblem = checkOutDir(outAbs, rootDir, dumpsAbs) ??
    (await checkOutDirContents(outAbs, worlds.map((w) => w.slug)))
  if (outProblem) errors.push(`output directory ${outAbs}: ${outProblem}`)

  // 2. Dumps, in sorted path order so "first wins" is reproducible.
  const worldById = new Map(worlds.map((w) => [w.id, w]))
  const worldBySlug = new Map(worlds.map((w) => [w.slug, w]))
  /** @type {Map<string, { file: string, dump: import('../src/lib/dump.js').NormalizedDump }[]>} */
  const perWorld = new Map(worlds.map((w) => [w.id, []]))
  const files = await listDumpFiles(dumpsAbs, { explicit: dumpsDir !== undefined, errors, warnings, show })
  if (worlds.length) {
    for (const relPath of files) {
      const abs = path.join(dumpsAbs, ...relPath.split('/'))
      const file = show(abs)
      const segments = relPath.split('/')
      /** @type {World|undefined} */
      let folderWorld
      if (segments.length > 1) {
        folderWorld = worldById.get(segments[0]) ?? worldBySlug.get(segments[0])
        if (!folderWorld) {
          errors.push(`${file}: folder '${segments[0]}' is not a world id (expected one of ${worlds.map((w) => w.id).join(', ')})`)
          continue
        }
      }
      let raw
      try {
        raw = parseDumpText(await readFile(abs, 'utf8'), file)
      } catch (e) {
        errors.push(/** @type {Error} */ (e).message)
        continue
      }
      const checked = validateDump(raw, { defaultPlanet: folderWorld?.id })
      warnings.push(...checked.warnings.map((w) => `${file}: ${w}`))
      errors.push(...checked.errors.map((e) => `${file}: ${e}`))
      const dump = checked.dump
      if (!dump) continue
      if (!worldById.has(dump.planet)) {
        const near = worlds.find((w) => w.id.toLowerCase() === dump.planet.toLowerCase())
        errors.push(`${file}: unknown planet '${dump.planet}'` +
          (near ? ` (did you mean '${near.id}'? planet ids are case-sensitive)` : ` (known: ${worlds.map((w) => w.id).join(', ')})`))
        continue
      }
      if (folderWorld && dump.planet !== folderWorld.id) {
        errors.push(`${file}: planet '${dump.planet}' does not match its folder '${segments[0]}' (${folderWorld.id})`)
        continue
      }
      if (dump.randomizeMineables) alerts.push(file)
      const bucket = /** @type {{ file: string, dump: any }[]} */ (perWorld.get(dump.planet))
      bucket.push({ file, dump })
    }
  }
  if (errors.length || !taxonomy) throw new BuildDataError(errors, warnings)

  // 3. Merge and publish per world.
  /** @type {WorldReport[]} */
  const reports = []
  /** @type {{ file: string, text: string }[]} */
  const outputs = []
  const indexWorlds = []
  for (const w of worlds) {
    const entries = /** @type {{ file: string, dump: any }[]} */ (perWorld.get(w.id))
    const merged = mergeDumps(entries.map((e) => e.dump), { planet: w.id, names: entries.map((e) => e.file) })
    warnings.push(...merged.warnings.map((m) => `${w.id}: ${m}`))
    const runtimeExcluded = includeRuntime
      ? 0
      : merged.objects.filter((o) => o.id != null && o.id >= RUNTIME_ID_MIN).length
    const { format, world, ...rest } = toWorldData(merged, { includeRuntime })
    const data = { format, world, ...rest }
    const rev = revOf(data)
    const file = `${w.slug}.json`
    outputs.push({ file, text: JSON.stringify({ format, world, rev, ...rest }) + '\n' })

    /** @type {Map<string, number>} */
    const unknown = new Map()
    for (const p of data.points) {
      const gId = data.gids[p[0]]
      if (taxonomy.classify(gId) === OTHER_ID) unknown.set(gId, (unknown.get(gId) ?? 0) + 1)
    }
    reports.push({
      id: w.id,
      file,
      count: data.points.length,
      rev,
      dumps: entries.map((e) => e.file),
      stats: merged.stats,
      runtimeExcluded,
      unknownGids: [...unknown].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    })
    indexWorlds.push({
      id: w.id,
      slug: w.slug,
      name: w.name,
      kind: w.kind,
      access: w.access,
      hash: w.hash,
      frame: w.frame,
      extent: extentOf(data.points),
      count: data.points.length,
      file,
      rev,
      basemap: w.basemap ?? null,
    })
  }
  const index = { format: INDEX_FORMAT, worlds: indexWorlds, groups: taxonomy.groups, categories: taxonomy.categories }

  // 4. Write: recreate the output directory so stale files never survive.
  await rm(outAbs, { recursive: true, force: true })
  await mkdir(outAbs, { recursive: true })
  await writeFile(path.join(outAbs, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  for (const o of outputs) await writeFile(path.join(outAbs, o.file), o.text)

  // 5. Report.
  const pad = Math.max(...worlds.map((w) => w.id.length))
  log(`build-data: ${worlds.length} world(s), ${files.length} dump file(s) from ${show(dumpsAbs)} -> ${show(outAbs)}`)
  for (const r of reports) {
    const s = r.stats
    log(`  ${r.id.padEnd(pad)}  ${String(r.count).padStart(6)} point(s)  rev ${r.rev}  ${r.file}` +
      (r.dumps.length
        ? `  [${r.dumps.length} dump(s): ${s.input} in, ${s.duplicates} duplicate(s), ${s.conflicts} conflict(s), ` +
          `${r.runtimeExcluded} runtime excluded]`
        : '  [no dumps]'))
  }
  const unknownWorlds = reports.filter((r) => r.unknownGids.length)
  if (unknownWorlds.length) {
    log("gIds with no category (published under 'other'; add them to data/categories.json):")
    for (const r of unknownWorlds) log(`  ${r.id}: ${r.unknownGids.map(([g, n]) => `${g} x${n}`).join(', ')}`)
  }
  if (warnings.length) {
    log(`warnings (${warnings.length}):`)
    for (const w of warnings) log(`  - ${w}`)
  }
  const alertLines = alerts.length
    ? [
        '!!! WARNING: randomizeMineables is TRUE in the dump(s) below. Ore types there were shuffled by the save',
        '!!! settings and do not match a vanilla world. Remove these dumps before publishing:',
        ...alerts.map((f) => `!!!   ${f}`),
      ]
    : []
  for (const line of alertLines) log(line)

  return { outDir: outAbs, index, worlds: reports, warnings, alerts: alertLines }
}

// ---------------------------------------------------------------------------------------------
// helpers

/** @param {unknown} f @returns {string|null} problem, or null when sane */
function checkFrame(f) {
  if (!Array.isArray(f) || f.length !== 4 || !f.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return `must be [minX, minZ, maxX, maxZ] finite numbers (got ${JSON.stringify(f)})`
  }
  if (!(f[0] < f[2] && f[1] < f[3])) return `must have minX < maxX and minZ < maxZ (got ${JSON.stringify(f)})`
  if (f.some((v) => Math.abs(v) > FRAME_LIMIT)) return `values must be within ±${FRAME_LIMIT} (got ${JSON.stringify(f)})`
  return null
}

/** @param {string} url */
function isPlainRelativeUrl(url) {
  return url.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/') && !/[?#\\]/.test(url) &&
    !url.split('/').includes('..')
}

/**
 * Refuse output directories whose deletion would destroy sources.
 * @param {string} outAbs @param {string} rootDir @param {string} dumpsAbs
 */
function checkOutDir(outAbs, rootDir, dumpsAbs) {
  const contains = (/** @type {string} */ outer, /** @type {string} */ inner) => {
    const r = path.relative(outer, inner)
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
  }
  if (path.parse(outAbs).root === outAbs) return 'refusing to use a file-system root'
  if (contains(outAbs, rootDir)) return 'refusing to delete a directory that contains the project root'
  if (contains(outAbs, dumpsAbs)) return 'refusing to delete a directory that contains the dumps'
  if (contains(outAbs, path.join(rootDir, 'data'))) return 'refusing to delete the data/ sources'
  if (contains(dumpsAbs, outAbs)) return 'refusing to delete a directory inside the dumps'
  if (contains(path.join(rootDir, 'data'), outAbs)) return 'refusing to delete a directory inside the data/ sources'
  return null
}

/**
 * The output directory is deleted and recreated, so it may only hold what this script writes
 * (top-level pcmap-index/N and pcmap-world/N *.json of any version, or index.json/<slug>.json
 * left unparseable by an interrupted write) plus OS metadata files. Anything else means the path
 * is probably a mistake (e.g. `--out src`, or a dumps folder passed as `--out`).
 * @param {string} outAbs @param {string[]} slugs of the configured worlds
 */
async function checkOutDirContents(outAbs, slugs) {
  let entries
  try {
    entries = await readdir(outAbs, { withFileTypes: true })
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code
    if (code === 'ENOENT') return null
    return code === 'ENOTDIR' ? 'exists and is not a directory' : `cannot be read (${/** @type {Error} */ (e).message})`
  }
  const generated = new Set(['index.json', ...slugs.map((s) => `${s}.json`)])
  /** @type {string[]} */
  const foreign = []
  let dumps = false
  for (const e of entries) {
    if (e.isFile() && OS_JUNK_RE.test(e.name)) continue
    const format = e.isFile() && /\.json$/i.test(e.name) ? await formatOf(path.join(outAbs, e.name)) : undefined
    if (typeof format === 'string' && OUTPUT_FORMAT_RE.test(format)) continue
    if (format === null && generated.has(e.name)) continue
    if (format === DUMP_FORMAT) dumps = true
    foreign.push(e.name)
  }
  if (!foreign.length) return null
  foreign.sort()
  return `refusing to delete it: it holds entries build-data does not write (${foreign.slice(0, 3).join(', ')}` +
    `${foreign.length > 3 ? ', ...' : ''}); ` +
    (dumps ? `some are ${DUMP_FORMAT} dumps; choose another --out` : 'empty it or choose another --out')
}

/**
 * The top-level string `format` of a JSON file: undefined when it parses without one, null when
 * it cannot be read or parsed (e.g. truncated).
 * @param {string} abs @returns {Promise<string|null|undefined>}
 */
async function formatOf(abs) {
  let json
  try {
    const text = await readFile(abs, 'utf8')
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
  return isObject(json) && typeof json.format === 'string' ? json.format : undefined
}

/**
 * Read and parse a JSON source; record an error instead of throwing.
 * @param {string} abs @param {string} label @param {string[]} errors
 */
async function readJson(abs, label, errors) {
  let text
  try {
    text = await readFile(abs, 'utf8')
  } catch (e) {
    errors.push(`${label}: cannot read (${/** @type {Error} */ (e).message})`)
    return undefined
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (e) {
    errors.push(`${label}: invalid JSON: ${/** @type {Error} */ (e).message}`)
    return undefined
  }
}

/**
 * Dump files under `dir` as sorted '/'-separated relative paths. Dotfiles, dot-directories and
 * Markdown are skipped silently; other non-dump files are skipped with a warning. A missing `dir`
 * is a warning when it is the default and an error when it was given explicitly.
 * @param {string} dir
 * @param {{ explicit: boolean, errors: string[], warnings: string[], show: (p: string) => string }} ctx
 */
async function listDumpFiles(dir, { explicit, errors, warnings, show }) {
  /** @type {string[]} */
  const out = []
  /** @param {string} abs @param {string} rel */
  const walk = async (abs, rel) => {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code
      if (rel === '' && code === 'ENOENT' && !explicit) {
        warnings.push(`${show(dir)}: no dumps directory; every world will be empty`)
        return
      }
      if (rel === '' && (code === 'ENOENT' || code === 'ENOTDIR')) {
        errors.push(`${show(dir)}: dumps directory ${code === 'ENOENT' ? 'does not exist' : 'is not a directory'}`)
        return
      }
      throw e
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(path.join(abs, e.name), childRel)
      else if (e.isFile() && DUMP_EXT_RE.test(e.name)) out.push(childRel)
      else if (!/\.md$/i.test(e.name)) {
        warnings.push(`${show(path.join(abs, e.name))}: ignored (not a regular .json or .csv file)`)
      }
    }
  }
  await walk(dir, '')
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** @param {number[][]} points @returns {Frame|null} */
function extentOf(points) {
  if (!points.length) return null
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const [, x, , z] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return [minX, minZ, maxX, maxZ]
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = `usage: node scripts/build-data.mjs [--dumps <dir>] [--out <dir>] [--include-runtime] [--quiet]
  --dumps <dir>        dump directory (default data/dumps)
  --out <dir>          output directory, deleted and recreated (default public/data)
  --include-runtime    keep objects with id >= ${RUNTIME_ID_MIN} (player builds, wreck contents)
  --quiet, -q          print errors and randomizeMineables alerts only`

/** @param {string[]} argv @returns {Promise<number>} exit code */
async function main(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        dumps: { type: 'string' },
        out: { type: 'string' },
        'include-runtime': { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch (e) {
    console.error(`build-data: ${/** @type {Error} */ (e).message}\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  try {
    const result = await buildData({
      dumpsDir: values.dumps === undefined ? undefined : path.resolve(values.dumps),
      outDir: values.out === undefined ? undefined : path.resolve(values.out),
      includeRuntime: values['include-runtime'],
      log: values.quiet ? () => {} : console.log,
    })
    if (values.quiet) for (const line of result.alerts) console.error(line)
    return 0
  } catch (e) {
    if (e instanceof BuildDataError) {
      if (e.warnings.length) console.error(`warnings (${e.warnings.length}):\n  - ${e.warnings.join('\n  - ')}`)
      console.error(e.message)
    } else {
      console.error(/** @type {Error} */ (e)?.stack ?? e)
    }
    return 1
  }
}

const invokedDirectly = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2))
