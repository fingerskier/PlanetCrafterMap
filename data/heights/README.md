# `data/heights/`: heightmaps for the relief basemap

One folder per world id (`Prime/`, `Humble/`, …) holding `*.heights.gz` files (`pcmap-heights/1`) written by
[`tools/dumper`](../../tools/dumper/README.md#heights-pcmap-heights1) next to its object dump. `npm run data` renders
the last file of each world (in sorted order) into a shaded-relief PNG and points that world's `basemap` at it.
A world without one shows the plain grid.

The files hold sampled ground heights only (numbers, no textures or images). As with the dumps, publishing
them is the maintainer's call: see [`../dumps/README.md`](../dumps/README.md#rules).
The layout is in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#heightmap-pcmap-heights1-pipeline-input).
