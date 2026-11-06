# PCMapDumper (`tools/dumper`)

A BepInEx 5 (Mono) plugin for *The Planet Crafter*. It writes the current planet's **developer-placed
scene objects** (ores, crates, wreck props, collectibles, …) to a [`pcmap-dump/1`](../../docs/ARCHITECTURE.md#dump-pcmap-dump1-pipeline-input-also-importable-in-the-browser)
JSON file. The map's published data is **generated** this way, because no openly licensed POI dataset exists.

> [!NOTE]
> **STATUS: works.** Built with the .NET 8 SDK and run in game 2.104 (Steam via Proton on Linux, BepInEx 5.4.23.6)
> on 2026-11-06. It dumped Prime in one go: 66 sectors found, 63 loaded, 2 already loaded, 1 "failed" (`3D`, an
> object that carries a `Sector` component but is not a scene; Unity logs *Scene '3D' couldn't be loaded*,
> which is harmless), 27,090 objects across 55 gIds. The code compiled without changes. CI still cannot build it,
> because building needs the game's proprietary DLLs. CI only runs `tools/dumper/dumper.test.js`, a Node check
> that the hand-synced constants and the documented output shape agree with `docs/ARCHITECTURE.md` and
> `src/lib/planets.js`.

## What it does

When you press **Ctrl+Shift+F9** (the default; see [Configuration](#configuration-bepinexconfigplanetcraftermappcmapdumpercfg))
inside a loaded world, the plugin:

1. Optionally (on by default) **loads every Sector scene** of the planet, one at a time. Sectors are the
   chunks the game streams in near the player. Without this step, only nearby objects exist in memory.
2. Waits a few frames for the loaded sectors to settle.
3. Lists every `WorldObjectFromScene` component, inactive ones included. It skips anything inside a
   **procedural wreck instance** (per-save generated content) and records `{ id, gId, pos }`, with
   positions rounded to 0.01.
4. Writes `<GameDir>/BepInEx/config/pcmap-dumps/<Planet>-<yyyyMMdd-HHmmss>.json` (local time; change the folder
   with `Output.Directory`) and logs the full path and counts to the BepInEx log (`<GameDir>/BepInEx/LogOutput.log`).
   A short message also appears on the HUD.

It **does not** write to the save, spawn or remove anything, or patch game code (no Harmony). Its only side
effect is the extra sector scenes it loads. That load is heavy and the game was not designed for it, so
**restart the game after dumping**. Do not keep playing that session, and do not let it save.

## Requirements

- *The Planet Crafter* (PC, Steam or another store), any recent build. The API was cross-checked against mods
  that target game 2.104.
- [BepInEx 5.4.x](https://github.com/BepInEx/BepInEx/releases) for **Unity Mono, x64**, installed into the
  game folder and started once, so that `BepInEx/plugins` and `BepInEx/config` exist.
- **`HideManagerGameObject = true`** in `<GameDir>/BepInEx/config/BepInEx.cfg`, section `[Chainloader]`
  (BepInEx's default is `false`). Without it the game stops every plugin after initialization: the plugin
  loads, but `Update()` never runs, so the hotkey does nothing. If any of akarnokd's mods is installed, it has
  probably set this already. The plugin logs a warning at startup when the setting is off. See the
  [akarnokd/ThePlanetCrafterMods README](https://github.com/akarnokd/ThePlanetCrafterMods#readme).
- To build: a .NET SDK (6.0 or newer; any SDK that can target `netstandard2.1`) and network access to
  `nuget.bepinex.dev` and `nuget.org` (see `NuGet.Config`).

## Build

```bash
dotnet build tools/dumper/PCMapDumper.csproj -c Release -p:GameDir="C:\Program Files (x86)\Steam\steamapps\common\The Planet Crafter"
```

- Instead of `-p:GameDir=…`, you can set the environment variable `PLANET_CRAFTER_DIR`.
- Add `-p:Deploy=true` to copy the DLL straight into `<GameDir>/BepInEx/plugins/PCMapDumper/`.
- The output is `tools/dumper/bin/Release/netstandard2.1/PCMapDumper.dll`.
- Game assemblies are referenced from `<GameDir>/Planet Crafter_Data/Managed/` at compile time only
  (`Private=false`). They are never copied into the output, and they must never be committed.
- If the compiler reports `CS0012: The type 'X' is defined in an assembly that is not referenced`, add a
  `<Reference>` for the named DLL from `Managed/` to `PCMapDumper.csproj`, following the existing entries.
- On Linux or macOS (for example, a Proton install), file names are case-sensitive. Check that the `HintPath` names
  match the files in `Managed/`. They do for game 2.104.
- Linux without a system SDK: `curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir ~/.dotnet`,
  then build with `DOTNET_ROOT=~/.dotnet ~/.dotnet/dotnet build … -p:GameDir="$HOME/.local/share/Steam/steamapps/common/The Planet Crafter"`.

## Install

Copy `PCMapDumper.dll` to `<GameDir>/BepInEx/plugins/PCMapDumper/`. In `<GameDir>/BepInEx/config/BepInEx.cfg`,
set `HideManagerGameObject = true` under `[Chainloader]` (see [Requirements](#requirements)). Start the game once.
On Proton (Linux / Steam Deck), unzip the **win_x64** BepInEx build and set the game's Steam launch option to
`WINEDLLOVERRIDES="winhttp=n,b" %command%`, or Wine ignores BepInEx's `winhttp.dll`. Starting the game creates `BepInEx/config/planetcraftermap.pcmapdumper.cfg`. The log should show
`PCMap Dumper <version> loaded. Dump key: Ctrl+Shift+<Keyboard>/f9. Output: <folder>` and no `HideManagerGameObject` warning.

## Usage (recommended procedure)

1. Start a **new, throwaway save** on the planet you want to dump. In the new-game options, leave
   **"randomize mineables" OFF**. A fresh save matters because objects that a save has already mined or
   collected may be missing from the scene. With randomization on, ore *types* differ from vanilla.
2. Once you are in the world, press **Ctrl+Shift+F9** (or your configured hotkey). The game may freeze for a while
   as every sector loads. If nothing happens at all (no HUD text, no log line), check `HideManagerGameObject`.
3. Wait for the HUD or the log line `PCMap dump written: …`.
4. **Quit to desktop without saving** and restart the game before you play again.
5. Repeat for each planet. Each dump covers only the planet you are on.

Example log output:

```
[Info   :PCMap Dumper] PCMap dump written: C:\…\BepInEx\config\pcmap-dumps\Prime-20261104-201500.json
[Info   :PCMap Dumper] planet=Prime gameVersion=2.104 randomizeMineables=false objects=… gIds=… | scene objects found=…, skipped: in procedural instance=…, …
[Info   :PCMap Dumper] Top gIds: …
```

### Configuration (`BepInEx/config/planetcraftermap.pcmapdumper.cfg`)

| Section | Key | Default | Meaning |
|---|---|---|---|
| Hotkey | `Key` | `<Keyboard>/f9` | Unity Input System binding path. A bare name such as `f9` is accepted. |
| Hotkey | `RequireCtrl` | `true` | Ctrl (left or right) must be held. |
| Hotkey | `RequireShift` | `true` | Shift (left or right) must be held. |
| Dump | `LoadAllSectors` | `true` | Load every Sector scene before scanning. If `false`, only the currently loaded area is dumped. |
| Dump | `SectorLoadTimeoutSeconds` | `120` | Stop waiting for one sector after this many real seconds. |
| Dump | `SettleFrames` | `30` | Frames to wait after loading and before scanning (1–600). |
| Dump | `IncludeInactive` | `true` | Include inactive scene objects. |
| Dump | `SkipProceduralInstances` | `true` | Skip objects inside procedural wreck instances. |
| Output | `Directory` | *(empty)* | Output folder. Empty means `<BepInEx config dir>/pcmap-dumps`. Environment variables are expanded. |

## Output format

UTF-8 (no BOM), one object per line, sorted by `(gId, id, x, z, y)`, so that repeated dumps diff cleanly.
The values below are **synthetic** and show only the shape:

```json
{
  "format": "pcmap-dump/1",
  "planet": "Prime",
  "gameVersion": "9.999",
  "randomizeMineables": false,
  "source": "pcmap-dumper 0.1.0",
  "objects": [
    {"id": 123456789, "gId": "ExampleOre", "pos": [10.5, 20, -30.25]},
    {"id": null, "gId": "ExampleOre", "pos": [-1.01, 0, 2]}
  ]
}
```

- `planet` is `PlanetData.id`, with `""` written as `"Prime"`.
- `gameVersion` is `Application.version`.
- `randomizeMineables` is the save's game setting, or `null` if it could not be read.
- `id` is `WorldObjectFromScene.GetUniqueId()`, or `null` when the id is not positive. Scene ids are
  normally in `[100000000, 200000000)`. The log counts any ids outside that range, but the plugin does not
  filter them out. The pipeline decides what to do with them.
- `gId` is `GetGroupData().id` exactly as the game spells it, including the game's own misspellings.
- `pos` is `transform.position` as `[x, y, z]`, rounded to 0.01. Unity's axes are Y-up, so the map plane is X/Z.

## Feeding the pipeline

1. Copy the file into `data/dumps/<WorldId>/` in this repo. `<WorldId>` is the `planet` value, for example
   `data/dumps/Prime/Prime-20261104-201500.json`. See `data/dumps/README.md`.
2. Run `npm run data`. It validates, merges and de-duplicates all dumps of a world (by `id`, or by
   `gId@x:y:z` when there is no id), classifies gIds with `data/categories.json`, and writes `public/data/`.
3. Check the result with `npm run dev`. Unknown gIds show up under the `other` category. Add `match` rules to
   `data/categories.json` for them.

You can also load a dump straight into the web app (Import button) to view it locally without publishing it.

## Limitations

- Tested on Prime only so far (see STATUS). The other worlds have not been dumped yet.
- Only `WorldObjectFromScene` objects are dumped. Scene props that carry only an `Action*` component (for example
  `ActionMinable`) and no `WorldObjectFromScene` are not included. Ore veins, caves, lakes and other terrain
  features are not covered either. The scan in `Plugin.Scan()` is the extension point for adding more sources.
- Objects removed by the current save (mined or picked up) may be destroyed and so missing. Use a fresh save.
- With randomize mineables ON, ore gIds are swapped. The file records `randomizeMineables: true`, and the
  log warns.
- `IncludeInactive` also captures objects that are hidden for reasons the plugin cannot see (for example,
  objects that appear only at some terraformation stage). Their positions are still developer-placed.
- Sectors are loaded with plain additive scene loads, the same approach as akarnokd's `/load-all-sectors`.
  The game's own streaming could in principle unload one before the scan runs. The game state after a dump
  is not supported, which is why you must restart.
- Procedural wrecks are excluded by `ProceduralInstancesHandler.IsInsideAnInstance`. If that handler is
  absent, nothing is filtered, and the log says `instance filter active=False`.
- Multiplayer (client side) has not been considered. Dump in single-player.

## API verification

Each call below was **checked against fetched upstream source**. Every file was compared byte for byte with
`raw.githubusercontent.com` at the pinned commit. *A* = akarnokd/ThePlanetCrafterMods @ `e90edc2`
(Apache-2.0). *A-cap* = the removed `CheatMinimap/Plugin_Capture.cs` @ `02eaf94`. *N* = mcnicki2002/PlanetCrafterMods
@ `9529137` (Apache-2.0). *P* = ChadOhman/PlanetNavigator @ `5aa2d0a` (MIT).

| API used | Seen at |
|---|---|
| `FindObjectsByType<Sector>(FindObjectsSortMode.None)`; scene name = `sector.gameObject.name` | A `FeatCommandConsole/Plugin.cs:3218-3229` |
| `SceneManager.LoadSceneAsync(name, LoadSceneMode.Additive)`, one sector at a time, awaited | A-cap `CheatMinimap/Plugin_Capture.cs:187-195` |
| `SceneManager.sceneCount` and `GetSceneAt(i).name` (skip sectors that are already loaded) | A-cap `Plugin_Capture.cs:171-179`, *in commented-out code* |
| `FindObjectsByType<WorldObjectFromScene>(FindObjectsInactive.Include, FindObjectsSortMode.None)` | A `FeatCommandConsole/Plugin.cs:3055` |
| `wos.GetGroupData()` and `.id`; `wos.transform.position` | A `FeatCommandConsole/Plugin.cs:3057-3058, 3064` |
| `wos.GetUniqueId()` | A `FeatCommandConsole/Plugin.cs:3089` |
| `Managers.GetManager<PlanetLoader>()?.GetCurrentPlanetData()`, `pd.id`, `""` meaning Prime | A `CheatMinimap/Plugin.cs:683-690`; P `mod/PlanetNavigator/PositionSampler.cs:26-30` |
| `ProceduralInstancesHandler.Instance` and `.IsInsideAnInstance(pos, false)` | A `CheatMinimap/Plugin.cs:417, 548` |
| `Managers.GetManager<PlayersManager>().GetActivePlayerController()` | A `FeatCommandConsole/Plugin.cs:3050`; A `CheatMinimap/Plugin.cs:255-256` |
| `Managers.GetManager<GameSettingsHandler>().GetCurrentGameSettings().GetRandomizeMineables()` | N `CheatCustomOreRandomization/Plugin.cs:57`; chain also at A `UIHotbar/Plugin.cs:343` |
| `Application.version` | A `LibCommon/GameVersionCheck.cs:31`; P `mod/PlanetNavigator/Plugin.cs:73` |
| `new InputAction(name, binding: path)`, `.Enable()`, `.enabled`, `.WasPressedThisFrame()`; `"<Keyboard>/"` prefix for bare keys | A `CheatMinimap/Plugin.cs:249-252, 276, 1134-1142` |
| `Keyboard.current[Key.LeftCtrl].isPressed`, `[Key.LeftShift]` | A `CheatMinimap/Plugin.cs:278, 283` |
| `Managers.GetManager<BaseHudHandler>()?.DisplayCursorText("", seconds, text)` | A `CheatAutoStore/Plugin.cs:527` |
| `Config.Bind(section, key, default, description)` | A `CheatMinimap/Plugin.cs:179-206` |
| `ConfigDescription` + `AcceptableValueRange<int>`; `ConfigEntry.SettingChanged` | P `mod/PlanetNavigator/Plugin.cs:55, 64` |
| `BaseUnityPlugin.StartCoroutine(IEnumerator)` | A `CheatMinimap/Plugin.cs:264`; P `mod/PlanetNavigator/Plugin.cs:90` |
| `BepInEx.Paths.ConfigPath` | N `QoLAutoLogistics/Plugin.cs:124` |
| `netstandard2.1`; `BepInEx.Core` 5.x from `nuget.bepinex.dev`; `$(GameDir)\Planet Crafter_Data\Managed\` | A `CheatMinimap/CheatMinimap.csproj:4`, `CheatMinimap/NuGet.Config:4`, `solution_private.targets:4, 16` |
| `BepInEx.Core` 5.4.21 together with `UnityEngine*.dll` and `Unity.Netcode.Runtime.dll` from `Managed` | P `mod/PlanetNavigator/PlanetNavigator.csproj:15-39` |

**Assumed.** These come from general Unity, Input System, BepInEx or .NET knowledge and were not seen in the
fetched sources:

- `AsyncOperation.isDone` polling. The capture code used the `completed` event instead.
  `Time.realtimeSinceStartup` and `Mathf.Max`.
- `FindObjectsInactive.Exclude`, used only when `IncludeInactive=false`. Only `.Include` was seen.
- `Key.RightCtrl` and `Key.RightShift`. Only the `Left*` keys were seen. `InputAction.Disable()`.
- The `Awake()` self-check `(gameObject.hideFlags & HideFlags.HideAndDontSave) == 0`. It assumes that the
  plugin's GameObject is BepInEx's manager object (`Chainloader.ManagerObject`), and that this object has
  `HideAndDontSave` exactly when `HideManagerGameObject = true`. A loader that puts plugins on another GameObject
  can make the check warn falsely, or stay silent when the setting is needed. The check only logs a warning.
- `GetUniqueId()` returns an integer type that converts implicitly to `long`. Its value is the stable
  scene id that save files use.
- `IsInsideAnInstance(pos, false)`: the meaning of the second argument is unknown. The call matches CheatMinimap.
- The exact DLL file names in `Managed/`. akarnokd writes them in lower case, which works on Windows. This
  csproj uses Unity's usual casing. It is also assumed that the listed references are enough to resolve the
  base types of the game classes used.
- Loading a sector that is already loaded is avoided by comparing scene names. Even if that check misses one,
  duplicate ids are dropped during the scan.
- The plugin GUID `planetcraftermap.pcmapdumper` is this project's own choice.

## License and attribution

Apache-2.0, like the rest of this repository. The plugin re-implements API usage patterns from
akarnokd/ThePlanetCrafterMods and mcnicki2002/PlanetCrafterMods (both Apache-2.0). No code was copied. See
[`NOTICE`](NOTICE) and the header of `Plugin.cs`. It ships no game code, art or text. Fan-made, and not affiliated
with Miju Games.
