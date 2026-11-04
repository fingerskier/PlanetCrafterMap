// Planet identity helpers. Pure: no DOM, safe in Node and the browser.

/**
 * Unity's `string.GetStableHashCode()`, which the game uses for `WorldObject.planet`
 * in save files: a two-accumulator djb2 over UTF-16 code units, stopping at NUL,
 * combined as `h1 + h2 * 1566083941` with int32 wrap-around.
 * Re-implemented from the documented algorithm (see docs/ARCHITECTURE.md).
 * @param {string} id planet id, e.g. "Prime" (case-sensitive)
 * @returns {number} signed int32
 */
export function planetHash(id) {
  let h1 = 5381 | 0
  let h2 = h1
  for (let i = 0; i < id.length && id.charCodeAt(i) !== 0; i += 2) {
    h1 = (((h1 << 5) + h1) | 0) ^ id.charCodeAt(i)
    if (i === id.length - 1 || id.charCodeAt(i + 1) === 0) break
    h2 = (((h2 << 5) + h2) | 0) ^ id.charCodeAt(i + 1)
  }
  return (h1 + Math.imul(h2, 1566083941)) | 0
}

/** Scene (developer-placed) object ids live in [SCENE_ID_MIN, RUNTIME_ID_MIN). */
export const SCENE_ID_MIN = 100_000_000
/** Objects created at runtime (player builds, procedural-wreck contents) have ids >= this. */
export const RUNTIME_ID_MIN = 200_000_000

/** @param {number} id */
export const isSceneId = (id) => Number.isInteger(id) && id >= SCENE_ID_MIN && id < RUNTIME_ID_MIN
