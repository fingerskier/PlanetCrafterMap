# PlanetCrafterMap

Interactive, **data-generated** maps of the worlds of *The Planet Crafter* (Prime, Humble, Selenea, Aqualis,
Toxicity, Skeo). It is a minimal-UI PWA that works offline once loaded, and it is deployed to GitHub Pages.

**Live:** https://fingerskier.github.io/PlanetCrafterMap/

## What you can do

- **Browse resource locations** (ores, veins, crates, wreck loot, collectibles, larvae/eggs, …) per world,
  toggle categories, search them, and click a point for its in-game `X:Y:Z` (the HUD format).
- **Import your own save** (Steam `…\AppData\LocalLow\MijuGames\Planet Crafter\*.json`, or a Game Pass blob).
  It is parsed **in your browser and never uploaded**. You see your base, placed objects, procedural-wreck sites
  and players on the right world, and published points you've already **collected** get dimmed or hidden.
- **Import a dump** (`pcmap-dump/1` JSON or CSV) to view data you generated yourself, without publishing it.
- **Share a view**: the URL hash holds the world, view, layers and pin.
- `Go to` accepts `X:Y:Z`, `X,Y,Z` or `X Z`.

## Where the data comes from

As of this writing there is **no openly licensed dataset** of Planet Crafter POI coordinates. The existing
interactive maps are proprietary compilations and must not be copied. So this repo ships the means to
**generate** the data instead:

1. `tools/dumper/` is a BepInEx 5 plugin. In-game, it dumps every developer-placed scene object
   (`id`, `gId`, position) of the current planet to a `pcmap-dump/1` file.
2. Drop the file into `data/dumps/<WorldId>/` (see [`data/dumps/README.md`](data/dumps/README.md)).
3. `npm run data` validates, de-duplicates, classifies (`data/categories.json`) and writes `public/data/`.
   The build runs this step every time, so the published JSON is always derived from the committed sources.

The basemap is generated too (a coordinate grid over each world's frame). **No game art, textures or game
text are shipped.** Whether to publish coordinates extracted from the game is the maintainer's call: see
[Legal](#legal).

## Develop

```bash
npm ci
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` runs the Vitest unit tests. `npm run test:e2e` runs Playwright against the production build, served
under `/PlanetCrafterMap/` and including offline mode.

The design, data contracts and module APIs are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Deploy

The workflow at `.github/workflows/pages.yml` tests every push and PR. On `main` it also builds and deploys to Pages.
This one-time repository setting is required: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The base path comes from `actions/configure-pages`, so a custom domain works without code changes.

## Legal

Fan-made and not affiliated with or endorsed by Miju Games. *The Planet Crafter* is their trademark.
This repo contains no game assets. Object ids and coordinates are facts read from the game, and their
redistribution status is unsettled (no publisher policy was found). The dumper is provided so that each
user can generate data from their own copy. Code is Apache-2.0 (see `LICENSE`).

## Acknowledgements

- [akarnokd/ThePlanetCrafterMods](https://github.com/akarnokd/ThePlanetCrafterMods) (Apache-2.0): per-world map
  frames, and the in-game API patterns the dumper adapts (see `tools/dumper/NOTICE`).
- [Valkerran/PCEdit wiki](https://github.com/Valkerran/PCEdit/wiki), for its documentation of the save format.
  The parser here is an independent implementation of that documented format.
