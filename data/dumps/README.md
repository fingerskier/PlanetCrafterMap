# `data/dumps/`: pipeline input

This folder holds **POI dumps**: per-world lists of developer-placed scene objects (ores, crates, wreck
props, collectibles, …) given as `id`, `gId` and position. `npm run data` (`scripts/build-data.mjs`) reads
every dump here, validates it, merges and de-duplicates the dumps per world, classifies each object with
[`../categories.json`](../categories.json), and writes `public/data/`. That output is gitignored and rebuilt
on every `npm run build`.

An empty folder is fine. Every world is still published, with zero points.

## Layout

```
data/dumps/
  Prime/      Prime-20261104-201500.json
  Humble/     humble-caves.csv
  Selenea/ …  (one folder per world id from ../worlds.json: Prime, Humble, Selenea, Aqualis, Toxicity, Skeo)
```

- Put each file in the folder named after its world id, which is case-sensitive. A file whose `planet` disagrees with its
  folder is an error. A file with no `planet` (for example a CSV without a `planet` column) takes the planet from its folder.
- A file directly in `data/dumps/` must name its planet itself.
- Files load in sorted path order, and when two files contain the same object, the first one wins.
  Name files so that the better source sorts first, for example with a date prefix.
- `.json` and `.csv` files are read. Dotfiles and `*.md` are skipped, and any other file is reported and skipped.
- Any error (unknown planet, folder mismatch, a malformed object) stops the build, lists every problem, and
  writes nothing.

## Where dumps come from

1. **`tools/dumper/`** (recommended) is a BepInEx plugin that writes the current planet's scene objects
   to a `pcmap-dump/1` file from a running game. Follow its [README](../../tools/dumper/README.md), in particular
   *use a fresh, throwaway save* and *quit without saving*.
2. **Any other tool** works too, as long as it emits either format below.

### `pcmap-dump/1` (JSON)

```json
{ "format": "pcmap-dump/1", "planet": "Prime", "gameVersion": "2.104", "randomizeMineables": false,
  "source": "pcmap-dumper 0.1.0",
  "objects": [ { "id": 101234567, "gId": "Iron", "pos": [12.5, 30.1, -40.2] } ] }
```

`id` is optional (an integer, or null; 0 also means unknown). `pos` is `[x, y, z]` or `"x,y,z"`, with Y as the height.

### CSV

```csv
id,gId,x,y,z,planet
101234567,Iron,12.5,30.1,-40.2,Prime
```

The header must contain `gId,x,y,z`, plus optionally `id` and `planet`, in any order and in any letter case. Extra columns
are ignored. Quoted fields and CRLF line endings are fine. A file holds one planet.

The full contract is in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#dump-pcmap-dump1-pipeline-input-also-importable-in-the-browser).

## What gets published

- Objects with `id >= 200000000` are **runtime** objects (player builds, procedural-wreck contents) and are
  dropped, unless you pass `--include-runtime`. Scene objects (`100000000 ≤ id < 200000000`) and objects without an id are kept.
- Duplicates are merged by `id`, or by `gId` plus the rounded position when there is no id. A duplicate with a
  different `gId`, or more than 1 unit away, is reported as a conflict.
- Coordinates are rounded to 0.1. A gId with no category shows up under **Other**, and the build report
  lists it so you can add it to `categories.json`.

## Rules

- **Never commit a dump from a `randomizeMineables` save.** That setting swaps which ore appears in each ore
  slot, so the dump would show the wrong ore types. The build prints a loud warning for any such file.
  Dump a fresh save with the option off.
- **No game art and no game text.** Dumps hold ids and coordinates only, and labels are our own wording in
  `categories.json`. Do not add names, descriptions or images taken from the game.
- **Legal caveat.** Object ids and coordinates are facts read from the game. No publisher policy was found
  that says whether redistributing them is allowed, so committing dumps here, which publishes them on the site,
  is **the maintainer's call**. Until the maintainer decides, keep dumps local: the pipeline and the in-page
  "import dump" feature both work without committing anything.
- Test fixtures live in `test/fixtures/dumps/` and are synthetic. Never copy real dumps or saves there.
