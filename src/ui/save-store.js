// Remembers the last imported save on this device (IndexedDB), so a reload or an offline visit keeps it.
// Where the browser has the File System Access API (Chromium), it also keeps a handle to the original file,
// so "Refresh save" can re-read the file the game keeps writing. Nothing here leaves the device.

const DB_NAME = 'pcmap'
const STORE = 'kv'
const KEY = 'save'

/**
 * @typedef {{ name: string, bytes: ArrayBuffer, savedAt: number, handle: FileSystemFileHandle|null }} StoredSave
 */

/** @returns {Promise<IDBDatabase>} */
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'))
  })
}

/** Storage operations run one after another, so a clear issued after a store cannot land before it. */
let queue = Promise.resolve()

/**
 * Queue one logical storage operation (all of its transactions, fallbacks included).
 * @template T
 * @param {() => Promise<T>} op
 * @returns {Promise<T>}
 */
function serial(op) {
  const next = queue.then(op)
  queue = next.then(() => {}, () => {})
  return next
}

/**
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<T>}
 */
async function runTx(mode, run) {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const req = run(t.objectStore(STORE))
      t.oncomplete = () => resolve(req.result)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

/** Tells other tabs of this app that the remembered save changed (they may now hold a save it no longer has). */
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('pcmap-save') : null

/**
 * Run `cb` when another tab stores or forgets the remembered save.
 * @param {() => void} cb
 */
export function onSaveChangedElsewhere(cb) {
  channel?.addEventListener('message', () => cb())
}

/**
 * Store a save, replacing the previous one. A handle that cannot be stored (a browser that cannot
 * structured-clone it) is dropped and the bytes are kept.
 * @param {{ name: string, bytes: ArrayBuffer, handle?: FileSystemFileHandle|null }} save
 * @returns {Promise<boolean>} whether the save is now stored
 */
export function storeSave({ name, bytes, handle = null }) {
  if (!hasIndexedDB()) return Promise.resolve(false)
  const value = { name, bytes, savedAt: Date.now(), handle }
  return serial(async () => {
    let ok = false
    try {
      await runTx('readwrite', (s) => s.put(value, KEY))
      ok = true
    } catch {
      if (handle) {
        try {
          await runTx('readwrite', (s) => s.put({ ...value, handle: null }, KEY))
          ok = true
        } catch {
          // not stored
        }
      }
    }
    if (ok) channel?.postMessage('stored')
    return ok
  })
}

/** @returns {Promise<StoredSave|null>} */
export function loadSave() {
  if (!hasIndexedDB()) return Promise.resolve(null)
  return serial(async () => {
    try {
      const v = await runTx('readonly', (s) => s.get(KEY))
      if (!v || typeof v.name !== 'string' || !(v.bytes instanceof ArrayBuffer)) return null
      return { name: v.name, bytes: v.bytes, savedAt: Number(v.savedAt) || 0, handle: v.handle ?? null }
    } catch {
      return null
    }
  })
}

/** @returns {Promise<boolean>} false when a stored save may still be there */
export function forgetSave() {
  if (!hasIndexedDB()) return Promise.resolve(true)
  return serial(async () => {
    try {
      await runTx('readwrite', (s) => s.delete(KEY))
      channel?.postMessage('forgotten')
      return true
    } catch {
      return false
    }
  })
}

/** True where a file picker that returns a re-readable handle exists. */
export const canPickWithHandle = () => typeof window.showOpenFilePicker === 'function'

/**
 * Let the user pick a save or dump and keep a handle to it.
 * @returns {Promise<{ file: File, handle: FileSystemFileHandle }|null>} null when the user cancels
 */
export async function pickWithHandle() {
  let handles
  try {
    handles = await window.showOpenFilePicker({
      id: 'pcmap-import',
      multiple: false,
      types: [{ description: 'Save or dump', accept: { 'application/json': ['.json'], 'text/csv': ['.csv'], 'text/plain': ['.txt'] } }],
      excludeAcceptAllOption: false,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
  const handle = handles[0]
  return { file: await handle.getFile(), handle }
}

/**
 * Re-read a file through its handle without prompting, if the browser still grants read access
 * (Chromium keeps it across visits when the user chose "Allow on every visit").
 * @param {FileSystemFileHandle} handle
 * @returns {Promise<File|null>} null when access would need a prompt or the file is gone
 */
export async function rereadIfGranted(handle) {
  try {
    // @ts-ignore: queryPermission is not in every lib.dom version
    if (typeof handle.queryPermission !== 'function' || (await handle.queryPermission({ mode: 'read' })) !== 'granted') return null
    return await handle.getFile()
  } catch {
    return null
  }
}

/**
 * Re-read a file through its handle, asking for read permission again if the browser dropped it.
 * Call from a user gesture (permission prompts need one), before any other await.
 * @param {FileSystemFileHandle} handle
 * @returns {Promise<File>}
 */
export async function rereadHandle(handle) {
  const opts = /** @type {const} */ ({ mode: 'read' })
  // @ts-ignore: queryPermission / requestPermission are not in every lib.dom version
  if (typeof handle.queryPermission === 'function' && (await handle.queryPermission(opts)) !== 'granted') {
    // @ts-ignore
    if ((await handle.requestPermission(opts)) !== 'granted') throw new Error('permission to read the file was not given')
  }
  return handle.getFile()
}

function hasIndexedDB() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}
