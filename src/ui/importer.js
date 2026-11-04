// Reads a user-selected file in the page (never uploaded) and tells a save from a dump.

import { mergeDumps, parseDumpText, validateDump } from '../lib/dump.js'
import { buildSaveOverlay, decodeSaveBytes, isSaveText, parseSave } from '../lib/save.js'

/**
 * @typedef {import('../lib/save.js').SaveOverlay} SaveOverlay
 * @typedef {import('../lib/dump.js').DumpObject} DumpObject
 * @typedef {{ kind: 'save', name: string, overlay: SaveOverlay }} SaveImport
 * @typedef {{ kind: 'dump', name: string, planet: string, source: string|null, gameVersion: string|null,
 *   objects: DumpObject[], duplicates: number, warnings: string[] }} DumpImport
 * @typedef {{ kind: 'error', name: string, errors: string[], warnings: string[] }} ImportError
 */

/**
 * @param {File} file
 * @param {object} ctx
 * @param {string[]} ctx.worldIds known world ids, e.g. ['Prime', 'Humble', ...]
 * @param {string} ctx.defaultPlanet world on screen, used for a dump that names no planet
 * @returns {Promise<SaveImport|DumpImport|ImportError>}
 */
export async function importFile(file, { worldIds, defaultPlanet }) {
  const name = file.name || 'file'
  const fail = (/** @type {string[]} */ errors, /** @type {string[]} */ warnings = []) =>
    /** @type {ImportError} */ ({ kind: 'error', name, errors, warnings })
  let text
  try {
    text = decodeSaveBytes(await file.arrayBuffer())
  } catch (e) {
    return fail([`${name}: ${errorMessage(e)}`])
  }

  if (isSaveText(text)) {
    try {
      const parsed = parseSave(text)
      return { kind: 'save', name, overlay: buildSaveOverlay(parsed, worldIds) }
    } catch (e) {
      return fail([`${name} looks like a save file but could not be read: ${errorMessage(e)}`])
    }
  }

  let raw
  try {
    raw = parseDumpText(text, name)
  } catch (e) {
    return fail([`${name} is neither a save file nor a readable dump: ${errorMessage(e)}`])
  }
  const { dump, errors, warnings } = validateDump(raw, { defaultPlanet })
  if (!dump) return fail(errors.map((m) => `${name}: ${m}`), warnings)
  if (!worldIds.includes(dump.planet)) {
    const hint = worldIds.find((id) => id.toLowerCase() === dump.planet.toLowerCase())
    return fail([`${name}: unknown planet '${dump.planet}'` + (hint ? ` (did you mean '${hint}'?)` : '') +
      `; expected one of ${worldIds.join(', ')}`], warnings)
  }
  const merged = mergeDumps([dump])
  return {
    kind: 'dump',
    name,
    planet: dump.planet,
    source: dump.source,
    gameVersion: dump.gameVersion,
    objects: merged.objects,
    duplicates: merged.stats.duplicates,
    warnings: [...warnings, ...merged.warnings],
  }
}

/** @param {unknown} e */
const errorMessage = (e) => (e instanceof Error ? e.message : String(e))
