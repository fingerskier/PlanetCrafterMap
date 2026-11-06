# Architecture

PlanetCrafterMap is a static PWA that renders **data-generated** maps of The Planet Crafter worlds.
It is a renderer plus a pipeline. It is not a bundle of hand-placed markers.

```
 game install ──(tools/dumper: BepInEx plugin)──▶ pcmap-dump/1 JSON ─┐
 any other tool ─────────────────────────────▶ pcmap-dump/1 or CSV ─┤
                                                                    ▼
 data/worlds.json + data/categories.json + data/dumps/<World>/* ──(scripts/build-data.mjs)──▶ public/data/*.json
                                                                    │
                                                         vite build ▼
                                                     dist/ ──(Actions)──▶ GitHub Pages (PWA, offline)

 browser: user drops a save file or a dump ──(src/lib/save.js | src/lib/dump.js)──▶ local overlay (never uploaded)
```

## Ground truth (from research; see the PR description for sources)

- Worlds (`PlanetData.id`, case-sensitive): `Prime`, `Humble`, `Selenea`, `Aqualis`, `Toxicity`, `Skeo`.
- Axes: Unity Y-up. The map plane is **X/Z**, with **+X east (right)** and **+Z north (up)**. Y is altitude.
- The in-game HUD shows coordinates as `X:Y:Z` (height in the middle).
- Save `WorldObject.planet` = Unity `GetStableHashCode(planetId)` as a signed int32:
  Prime −1140328421, Humble −486276833, Selenea −1016990411, Aqualis −1291310150, Toxicity 110910045, Skeo −440810600.
- World frames `[minX, minZ, maxX, maxZ]` are the calibration boxes from akarnokd's CheatMinimap (Apache-2.0).
  They give the **initial view**, and they are **not hard bounds**: real objects exist outside them.
- Scene (developer-placed) object ids are in `[100_000_000, 200_000_000)` and are stable across saves.
  Runtime objects (player builds, procedural-wreck contents) are `>= 200_000_000`.
- No openly licensed POI dataset exists, so resource data must be generated from the game (see `tools/dumper`).
  We ship **no game art and no game text**, only ids, coordinates and our own labels.

## Repository layout

| Path | Role |
|---|---|
| `index.html`, `src/main.js`, `src/ui/*`, `src/styles.css` | Client app (vanilla ESM + Leaflet 1.9, no framework) |
| `src/lib/*.js` | **Pure** modules (no DOM, no Vite-only imports), shared by the browser, Node scripts and tests |
| `data/worlds.json`, `data/categories.json` | Hand-maintained sources: world frames and the category taxonomy |
| `data/dumps/<WorldId>/*.json\|csv` | Generated POI dumps (inputs to the pipeline) |
| `scripts/build-data.mjs` | Pipeline: sources → `public/data/` (gitignored, rebuilt on every `npm run build`) |
| `tools/dumper/` | BepInEx 5 plugin that dumps scene objects from a running game into `pcmap-dump/1` |
| `test/` | Vitest unit tests (+ `test/fixtures/`, synthetic data only) |
| `e2e/` | Playwright tests against the production build served under a subpath |
| `.github/workflows/pages.yml` | CI (unit + e2e) and the GitHub Pages deploy |

## Data contracts

All formats carry a `format` tag. Bump the major version on any breaking change.

### `data/worlds.json` (`pcmap-worlds/1`)

```json
{ "format": "pcmap-worlds/1",
  "worlds": [ { "id": "Prime", "slug": "prime", "name": "Prime", "kind": "planet", "access": "base",
                "hash": -1140328421, "frame": [-2000, -2000, 3000, 3000] } ] }
```

- `kind` is `planet | moon`. `access` is `base | dlc | free-update`.
- `hash` must equal `planetHash(id)` (a test enforces this).
- Optional `basemap`: `{ "type": "image", "url": "basemaps/prime.png", "bounds": [minX, minZ, maxX, maxZ] }`, for a
  generated, non-art image such as a hillshade from a heightmap. If it is absent, the client draws a generated grid.

### `data/categories.json` (`pcmap-categories/1`)

```json
{ "format": "pcmap-categories/1",
  "groups": [ { "id": "ore", "label": "Ores & minerals" } ],
  "categories": [ { "id": "iron", "label": "Iron", "group": "ore", "color": "#9aa3ad", "match": ["Iron"] },
                  { "id": "golden-effigy", "label": "Golden effigies", "group": "collectible",
                    "color": "#e8c547", "match": ["/^GoldenEffigie\\d+$/"] } ] }
```

- `match` entries are exact gIds or `/regex/` strings. The **first** matching category in file order wins.
- Unmatched gIds go to the implicit category `other` (group `other`), which the classifier always appends.
- Labels are our own wording. Do not copy game localisation text.

### Dump (`pcmap-dump/1`): pipeline input, also importable in the browser

```json
{ "format": "pcmap-dump/1", "planet": "Prime", "gameVersion": "2.104", "randomizeMineables": false,
  "source": "pcmap-dumper 0.1.0",
  "objects": [ { "id": 101234567, "gId": "Iron", "pos": [12.5, 30.1, -40.2] } ] }
```

- `id` is optional (an integer, or null). `pos` is `[x, y, z]` numbers or an `"x,y,z"` string.
- CSV alternative: a header row containing `gId,x,y,z` (with optional `id`, `planet`), in any column order.
- Dedup key: `id` when present, else `` `${gId}@${round(x)}:${round(y)}:${round(z)}` ``.

### Generated `public/data/index.json` (`pcmap-index/1`)

```json
{ "format": "pcmap-index/1",
  "worlds": [ { "id": "Prime", "slug": "prime", "name": "Prime", "kind": "planet", "access": "base", "hash": -1140328421,
                "frame": [-2000,-2000,3000,3000], "extent": [minX,minZ,maxX,maxZ] | null,
                "count": 0, "file": "prime.json", "rev": "0123456789ab", "basemap": null } ],
  "groups": [...], "categories": [...] }
```

`categories` includes the implicit `other` category. `extent` is the min/max of the published points, or null.
Each world's `rev` equals the `rev` of its world file; the client treats a mismatch as a page running an older (or newer) build.

### Generated `public/data/<slug>.json` (`pcmap-world/1`)

```json
{ "format": "pcmap-world/1", "world": "Prime", "rev": "0123456789ab",
  "gameVersion": "2.104" | null, "randomizeMineables": false | null, "sources": ["pcmap-dumper 0.1.0"],
  "gids": ["Cobalt", "Iron"],
  "points": [ [gidIndex, x, y, z, id], ... ] }
```

- `x, y, z` are rounded to 0.1. `id` is `0` when unknown. Points are sorted by `(gId, x, z, y, id)`, so output is deterministic.
- `rev` is the first 12 hex digits of the sha256 of this JSON serialized without `rev`.
- Fetch data files **without query strings**. The service-worker precache is keyed on the exact URL.

## Pure library APIs (`src/lib/`)

```js
// planets.js
planetHash(id: string): number                       // Unity GetStableHashCode, int32

// coords.js — Leaflet CRS.Simple: lat = z, lng = x
toLatLng(x, z): [number, number]                     // [z, x]
fromLatLng({lat, lng}): {x, z}
frameToBounds([minX,minZ,maxX,maxZ]): [[minZ,minX],[maxZ,maxX]]
parseCoordInput(str): {x, y: number|null, z} | null  // "x:y:z", "x,y,z", "x y z", "x;y;z"; 2 numbers = x,z
formatHud(x, y, z): string                           // "123:45:-678", rounded ints (HUD order X:Y:Z)

// state.js — URL hash (no paths: GitHub Pages serves 404 for deep paths)
decodeHash(hash: string): {world?, x?, z?, zoom?, layers?: string[], pin?: {x, z}}
encodeHash(state): string                            // '#w=prime&x=10&z=-20&zm=-1.5&l=iron,cobalt&p=10,-20'

// categories.js
compileCategories(categoriesJson): { categories, groups, classify(gId): categoryId, byId: Map }

// dump.js
parseDumpText(text: string, filename?: string): unknown            // JSON or CSV
validateDump(raw): { dump: NormalizedDump|null, errors: string[], warnings: string[] }
mergeDumps(dumps: NormalizedDump[], opts?): { planet, objects, stats }
toWorldData(merged, opts?: {includeRuntime?: boolean}): object      // pcmap-world/1 without rev
//   NormalizedDump = { planet, gameVersion|null, randomizeMineables|null, source|null,
//                      objects: [{ id: number|null, gId, x, y, z }] }

// save.js
decodeSaveBytes(bytes: ArrayBuffer|Uint8Array): string   // strict UTF-8, strips BOM
parseSave(text: string): ParsedSave
buildSaveOverlay(parsed: ParsedSave, worldIds: string[]): SaveOverlay
isSaveText(text: string): boolean                         // cheap sniff, used to tell a save from a dump on import
```

The client never sends imported files anywhere. Parsing happens in the page.

## Client behaviour

- Leaflet `CRS.Simple`, canvas renderer, one `circleMarker` per point, one `featureGroup` per category.
- Hash state is the single source of truth for world, view, enabled layers and pin, so every view is a shareable link.
- The basemap is a generated canvas `GridLayer` (frame outline plus an adaptive grid). An optional `basemap.image` overlay is drawn when present.
- Import (`[data-testid=import]`) auto-detects a save versus a dump:
  - Save: player positions, placed objects (built / wreck / scene), procedural-wreck instances, and
    **collected scene ids**, which dim or hide published points with the same stable id.
  - Dump: a local layer rendered like published data.
- The last imported **save** is remembered on the device (`src/ui/save-store.js`, IndexedDB `pcmap` / `kv` /
  `save`: `{ name, bytes, savedAt, handle }`) and restored on the next visit, without switching worlds.
  "Clear imported data" forgets it. Dumps are not remembered.
- Where `showOpenFilePicker` exists (Chromium), a trusted click on the import input opens that picker instead
  and the `FileSystemFileHandle` is stored with the save. `[data-testid=refresh-save]` ("Refresh save") re-reads
  the file through it (asking for read permission again if needed); on restore the live file is read silently
  when permission is still granted, else the stored copy is used. Without a handle the button opens the file
  input ("Re-import save…"). A remembered save that no longer parses is forgotten with a message.
- Test hooks: the `data-testid` attributes listed in `e2e/`, plus `window.__pcmap` (read-only debug handle).

## Deploy

`BASE_PATH` sets Vite's `base`. CI takes it from `actions/configure-pages` (`base_path`), so custom domains work.
The PWA uses `vite-plugin-pwa` (generateSW). The app shell and `data/*.json` are precached, so after the first visit the app works offline.
After a deploy the new worker takes over open pages (`skipWaiting` + `clientsClaim`). A page still running the previous build (a `controllerchange` on a page that was controlled at startup, or a `rev` mismatch) reloads once per tab session; with a dump loaded (or a save the browser could not store) it shows a "Map updated" notice with a Reload button instead.
