// PCMapDumper: part of PlanetCrafterMap (tools/dumper).
// Copyright (c) 2026 PlanetCrafterMap contributors. Licensed under the Apache License, Version 2.0.
//
// Dumps the current planet's developer-placed scene objects (WorldObjectFromScene) to a
// `pcmap-dump/1` JSON file. The format is specified in docs/ARCHITECTURE.md. The plugin only reads
// game state. The one exception is that it can load every Sector scene additively first, which is
// heavy, so restart the game after a dump.
//
// STATUS: this file has NOT been compiled or run in this repository's CI, because it needs the
// proprietary game DLLs. See README.md for which game APIs were checked against source and which
// were assumed.
//
// Attribution (see NOTICE). The game-API usage below re-implements patterns read in these
// Apache-2.0 sources. No file was copied.
//   akarnokd/ThePlanetCrafterMods @ e90edc20140278aee4a2ece2c62d9b630a2c9790
//   Copyright (c) 2022-2026, David Karnok & Contributors
//     FeatCommandConsole/Plugin.cs  /load-all-sectors (L3215-3233): FindObjectsByType<Sector>, then
//                                   SceneManager.LoadScene(sector.gameObject.name, LoadSceneMode.Additive)
//                                   /list-golden-containers (L3041-3097): FindObjectsByType<WorldObjectFromScene>
//                                   (FindObjectsInactive.Include, ...), GetGroupData().id, GetUniqueId()
//     CheatMinimap/Plugin.cs        PlanetLoader.GetCurrentPlanetData() and pd.id == "" meaning Prime (L683-690),
//                                   ProceduralInstancesHandler.Instance.IsInsideAnInstance(pos, false) (L417, L548),
//                                   InputAction key binding and Update() gating (L184, L247-283, L1134-1151)
//     CheatMinimap/Plugin_Capture.cs (removed in fdaa62e; read at 02eaf941b71b08564a7618a2dd82648100ce298c)
//                                   SceneManager.LoadSceneAsync one sector at a time, waiting for completion (L150-203)
//     CheatAutoStore/Plugin.cs      BaseHudHandler.DisplayCursorText("", seconds, text) (L527)
//   mcnicki2002/PlanetCrafterMods @ 95291376e1fcd8bd4e003122f5cb4352d4c9b3fe
//   Copyright 2025-2026 Nicolas Schaefer & Contributors
//     CheatCustomOreRandomization/Plugin.cs  GameSettingsHandler.GetCurrentGameSettings().GetRandomizeMineables() (L57)
//     QoLAutoLogistics/Plugin.cs             BepInEx Paths.ConfigPath (L124)

using BepInEx;
using BepInEx.Configuration;
using SpaceCraft;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace PCMapDumper
{
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class Plugin : BaseUnityPlugin
    {
        public const string PluginGuid = "planetcraftermap.pcmapdumper";
        public const string PluginName = "PCMap Dumper";
        /// <summary>Keep in sync with &lt;Version&gt; in PCMapDumper.csproj.</summary>
        public const string PluginVersion = "0.1.0";
        public const string DumpFormat = "pcmap-dump/1";
        public const string Source = "pcmap-dumper " + PluginVersion;

        // Mirrors SCENE_ID_MIN / RUNTIME_ID_MIN in src/lib/planets.js. Used for log statistics only.
        const long SceneIdMin = 100_000_000;
        const long RuntimeIdMin = 200_000_000;

        const string DefaultKey = "<Keyboard>/f9";

        ConfigEntry<string> dumpKey;
        ConfigEntry<bool> requireCtrl;
        ConfigEntry<bool> requireShift;
        ConfigEntry<bool> loadAllSectors;
        ConfigEntry<float> sectorTimeoutSeconds;
        ConfigEntry<int> settleFrames;
        ConfigEntry<bool> includeInactive;
        ConfigEntry<bool> skipProceduralInstances;
        ConfigEntry<string> outputDirectory;
        ConfigEntry<bool> heightsEnabled;
        ConfigEntry<float> heightsStep;
        ConfigEntry<int> heightsMaxCells;

        InputAction dumpAction;
        bool running;

        void Awake()
        {
            dumpKey = Config.Bind("Hotkey", "Key", DefaultKey,
                "Input System binding path of the dump key, e.g. <Keyboard>/f9. A bare key name (f9) is accepted.");
            requireCtrl = Config.Bind("Hotkey", "RequireCtrl", true, "Require Ctrl (left or right) to be held.");
            requireShift = Config.Bind("Hotkey", "RequireShift", true, "Require Shift (left or right) to be held.");

            loadAllSectors = Config.Bind("Dump", "LoadAllSectors", true,
                "Load every Sector scene of the planet before scanning. This is heavy: restart the game afterwards. "
                + "If false, only the sectors that are currently loaded are dumped.");
            sectorTimeoutSeconds = Config.Bind("Dump", "SectorLoadTimeoutSeconds", 120f,
                "Stop waiting for a single sector scene after this many real-time seconds.");
            settleFrames = Config.Bind("Dump", "SettleFrames", 30,
                new ConfigDescription("Frames to wait after loading sectors and before scanning.",
                    new AcceptableValueRange<int>(1, 600)));
            includeInactive = Config.Bind("Dump", "IncludeInactive", true,
                "Also dump inactive scene objects (FindObjectsInactive.Include).");
            skipProceduralInstances = Config.Bind("Dump", "SkipProceduralInstances", true,
                "Skip objects inside procedural wreck instances, which differ per save.");

            outputDirectory = Config.Bind("Output", "Directory", "",
                "Directory for dump files. Empty means <BepInEx config directory>/pcmap-dumps. "
                + "Environment variables are expanded. A relative path is relative to the game's working directory.");

            heightsEnabled = Config.Bind("Heights", "Enabled", true,
                "After the object dump, also sample the ground height on a grid and write <Planet>-<time>.heights.gz "
                + "(pcmap-heights/1), from which the map renders a shaded-relief basemap.");
            heightsStep = Config.Bind("Heights", "Step", 4f,
                new ConfigDescription("Grid spacing in metres.", new AcceptableValueRange<float>(0.5f, 64f)));
            heightsMaxCells = Config.Bind("Heights", "MaxCells", 4_000_000,
                new ConfigDescription("Upper bound on grid cells; the step doubles until the grid fits.",
                    new AcceptableValueRange<int>(10_000, 50_000_000)));

            BindKey();
            dumpKey.SettingChanged += (_, __) => BindKey();

            Logger.LogInfo(PluginName + " " + PluginVersion + " loaded. Dump key: "
                + DescribeHotkey() + ". Output: " + ResolveOutputDirectory());

            // BepInEx adds every plugin to its manager GameObject and sets HideAndDontSave on it only when
            // BepInEx.cfg has [Chainloader] HideManagerGameObject = true. Without that, the game stops plugins
            // after initialization: Update() never runs and the hotkey does nothing. See README.md, Requirements.
            if ((gameObject.hideFlags & HideFlags.HideAndDontSave) == 0)
            {
                Logger.LogWarning("HideManagerGameObject is false in BepInEx/config/BepInEx.cfg, so the dump hotkey "
                    + "will probably do nothing. Set [Chainloader] HideManagerGameObject = true and restart the game.");
            }
        }

        void BindKey()
        {
            string path = (dumpKey.Value ?? "").Trim();
            if (path.Length == 0)
            {
                path = DefaultKey;
            }
            if (!path.StartsWith("<", StringComparison.Ordinal))
            {
                path = "<Keyboard>/" + path;
            }
            dumpAction?.Disable();
            dumpAction = new InputAction("PCMap dump", binding: path);
            dumpAction.Enable();
        }

        string DescribeHotkey()
        {
            return (requireCtrl.Value ? "Ctrl+" : "") + (requireShift.Value ? "Shift+" : "") + dumpKey.Value;
        }

        void Update()
        {
            if (dumpAction == null)
            {
                return;
            }
            if (!dumpAction.enabled)
            {
                dumpAction.Enable();
                return;
            }
            if (!dumpAction.WasPressedThisFrame())
            {
                return;
            }
            var kb = Keyboard.current;
            if (kb == null)
            {
                return;
            }
            if (requireCtrl.Value && !(kb[Key.LeftCtrl].isPressed || kb[Key.RightCtrl].isPressed))
            {
                return;
            }
            if (requireShift.Value && !(kb[Key.LeftShift].isPressed || kb[Key.RightShift].isPressed))
            {
                return;
            }
            if (running)
            {
                Notify("PCMap dump is already running.", true);
                return;
            }
            StartCoroutine(DumpRoutine());
        }

        // ------------------------------------------------------------------------------------------
        // Dump flow: (1) optionally load sectors, (2) settle, (3) scan, (4) write.
        // ------------------------------------------------------------------------------------------

        IEnumerator DumpRoutine()
        {
            running = true;
            try
            {
                string planet = CurrentPlanetId();
                if (planet == null || !HasActivePlayer())
                {
                    Notify("PCMap dump: no planet is loaded. Load a save first.", true);
                    yield break;
                }
                Notify("PCMap dump of " + planet + " started. The game may freeze for a while.");

                var sectors = new SectorStats();
                if (loadAllSectors.Value)
                {
                    var known = LoadedSceneNames();
                    var all = FindObjectsByType<Sector>(FindObjectsSortMode.None);
                    sectors.Found = all.Length;
                    Logger.LogInfo("Sectors found: " + all.Length + ", scenes already loaded: " + known.Count);
                    foreach (var sector in all)
                    {
                        if (sector == null || sector.gameObject == null)
                        {
                            continue;
                        }
                        string name = sector.gameObject.name;
                        if (string.IsNullOrEmpty(name) || !known.Add(name))
                        {
                            sectors.AlreadyLoaded++;
                            continue;
                        }
                        var op = StartSectorLoad(name);
                        if (op == null)
                        {
                            sectors.Failed++;
                            continue;
                        }
                        float deadline = Time.realtimeSinceStartup + Mathf.Max(1f, sectorTimeoutSeconds.Value);
                        while (!op.isDone && Time.realtimeSinceStartup < deadline)
                        {
                            yield return null;
                        }
                        if (op.isDone)
                        {
                            sectors.Loaded++;
                        }
                        else
                        {
                            sectors.Failed++;
                            Logger.LogWarning("Sector " + name + " did not finish loading within the timeout.");
                        }
                    }
                }

                for (int i = 0; i < settleFrames.Value; i++)
                {
                    yield return null;
                }

                if (CurrentPlanetId() != planet)
                {
                    Notify("PCMap dump aborted: the planet changed during the dump.", true);
                    yield break;
                }

                string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
                var scan = ScanAndWrite(planet, sectors, stamp);
                if (scan != null && heightsEnabled.Value)
                {
                    yield return HeightsRoutine(planet, stamp, scan);
                }
            }
            finally
            {
                running = false;
            }
        }

        AsyncOperation StartSectorLoad(string name)
        {
            try
            {
                Logger.LogInfo("Loading sector " + name);
                return SceneManager.LoadSceneAsync(name, LoadSceneMode.Additive);
            }
            catch (Exception ex)
            {
                Logger.LogWarning("Could not load sector " + name + ": " + ex.Message);
                return null;
            }
        }

        static HashSet<string> LoadedSceneNames()
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                names.Add(SceneManager.GetSceneAt(i).name);
            }
            return names;
        }

        ScanResult ScanAndWrite(string planet, SectorStats sectors, string stamp)
        {
            try
            {
                var scan = Scan();
                string gameVersion = Application.version;
                bool? randomize = ReadRandomizeMineables();
                string json = DumpJson.Build(planet, gameVersion, randomize, Source, scan.Objects);
                string path = WriteDump(planet, stamp, json);

                int gIds = scan.Objects.Select(o => o.GId).Distinct(StringComparer.Ordinal).Count();
                Logger.LogInfo("PCMap dump written: " + path);
                Logger.LogInfo(string.Format(CultureInfo.InvariantCulture,
                    "planet={0} gameVersion={1} randomizeMineables={2} objects={3} gIds={4} | scene objects found={5}, "
                    + "skipped: in procedural instance={6}, no group={7}, duplicate id={8}, bad position={9}, errors={10} | "
                    + "ids outside scene range={11}, instance filter active={12} | sectors found={13}, loaded={14}, "
                    + "already loaded={15}, failed={16}",
                    planet, gameVersion, randomize.HasValue ? (randomize.Value ? "true" : "false") : "unknown",
                    scan.Objects.Count, gIds, scan.Found, scan.InInstance, scan.NoGroup, scan.Duplicates, scan.BadPosition,
                    scan.Errors, scan.OutsideSceneRange, scan.InstanceFilterActive, sectors.Found, sectors.Loaded,
                    sectors.AlreadyLoaded, sectors.Failed));
                if (scan.FirstError != null)
                {
                    Logger.LogWarning("First scan error: " + scan.FirstError);
                }
                var top = scan.Objects.GroupBy(o => o.GId, StringComparer.Ordinal)
                    .OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal).Take(20)
                    .Select(g => g.Key + "=" + g.Count());
                Logger.LogInfo("Top gIds: " + string.Join(", ", top));
                if (randomize == true)
                {
                    Logger.LogWarning("This save has randomizeMineables ON: ore types in this dump are randomized. "
                        + "Dump a fresh save with the option OFF for publishable data.");
                }

                Notify("PCMap dump: " + scan.Objects.Count + " objects of " + planet + " written to " + path
                    + (heightsEnabled.Value ? ". Sampling heights next." : ". Restart the game before playing on."));
                return scan;
            }
            catch (Exception ex)
            {
                Logger.LogError(ex);
                Notify("PCMap dump failed: " + ex.Message, true);
                return null;
            }
        }

        IEnumerator HeightsRoutine(string planet, string stamp, ScanResult scan)
        {
            List<Terrain> terrains;
            Rect rect;
            string how;
            float top, bottom;
            try
            {
                terrains = FindObjectsByType<Terrain>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                    .Where(t => t != null && t.terrainData != null).ToList();
                if (!Heights.Region(terrains, scan.Objects, out rect, out how))
                {
                    Notify("PCMap heights skipped: no terrain and no objects to bound the grid.", true);
                    yield break;
                }
                top = float.MinValue;
                bottom = float.MaxValue;
                foreach (var t in terrains)
                {
                    float y = t.transform.position.y;
                    top = Math.Max(top, y + t.terrainData.size.y);
                    bottom = Math.Min(bottom, y);
                }
                foreach (var o in scan.Objects)
                {
                    top = Math.Max(top, (float)o.Y);
                    bottom = Math.Min(bottom, (float)o.Y);
                }
                Logger.LogInfo(string.Format(CultureInfo.InvariantCulture,
                    "Heights: {0} terrain(s), region from {1} x [{2:0}, {3:0}] z [{4:0}, {5:0}], y [{6:0}, {7:0}]",
                    terrains.Count, how, rect.xMin, rect.xMax, rect.yMin, rect.yMax, bottom, top));
            }
            catch (Exception ex)
            {
                Logger.LogError(ex);
                Notify("PCMap heights failed: " + ex.Message, true);
                yield break;
            }

            Notify("PCMap heights: sampling " + planet + " (" + terrains.Count + " terrain(s)). The game may stutter.");
            HeightsResult result = null;
            yield return Heights.Sample(terrains, rect, heightsStep.Value, heightsMaxCells.Value, top + 100f,
                (top - bottom) + 400f, msg => Logger.LogInfo(msg), r => result = r);

            try
            {
                if (CurrentPlanetId() != planet)
                {
                    Notify("PCMap heights aborted: the planet changed while sampling.", true);
                    yield break;
                }
                string header = Heights.Header(planet, Application.version, Source, result);
                string path = Heights.Write(ResolveOutputDirectory(), SafeFileName(planet) + "-" + stamp, header, result);
                Logger.LogInfo("PCMap heights written: " + path + " | " + header);
                Logger.LogInfo(string.Format(CultureInfo.InvariantCulture,
                    "Heights: {0}x{1} cells at {2} m, terrain samples={3}, surface samples={4}",
                    result.Width, result.Height, result.Step, result.TerrainSamples, result.SurfaceSamples));
                Notify("PCMap heights: " + result.Width + "x" + result.Height + " grid written to " + path
                    + ". Restart the game before playing on.");
            }
            catch (Exception ex)
            {
                Logger.LogError(ex);
                Notify("PCMap heights failed: " + ex.Message, true);
            }
        }

        ScanResult Scan()
        {
            var r = new ScanResult();
            var ih = skipProceduralInstances.Value ? ProceduralInstancesHandler.Instance : null;
            r.InstanceFilterActive = ih != null;
            var mode = includeInactive.Value ? FindObjectsInactive.Include : FindObjectsInactive.Exclude;
            var all = FindObjectsByType<WorldObjectFromScene>(mode, FindObjectsSortMode.None);
            r.Found = all.Length;
            var seen = new HashSet<long>();

            foreach (var wos in all)
            {
                try
                {
                    if (wos == null)
                    {
                        continue;
                    }
                    var gd = wos.GetGroupData();
                    if (gd == null || string.IsNullOrEmpty(gd.id))
                    {
                        r.NoGroup++;
                        continue;
                    }
                    Vector3 p = wos.transform.position;
                    if (!IsFinite(p.x) || !IsFinite(p.y) || !IsFinite(p.z))
                    {
                        r.BadPosition++;
                        continue;
                    }
                    if (ih != null && ih.IsInsideAnInstance(p, false))
                    {
                        r.InInstance++;
                        continue;
                    }
                    long id = wos.GetUniqueId();
                    if (id > 0 && !seen.Add(id))
                    {
                        r.Duplicates++;
                        continue;
                    }
                    if (id < SceneIdMin || id >= RuntimeIdMin)
                    {
                        r.OutsideSceneRange++;
                    }
                    r.Objects.Add(new DumpObject(id > 0 ? id : 0, gd.id,
                        DumpJson.Round2(p.x), DumpJson.Round2(p.y), DumpJson.Round2(p.z)));
                }
                catch (Exception ex)
                {
                    r.Errors++;
                    if (r.FirstError == null)
                    {
                        r.FirstError = ex.GetType().Name + ": " + ex.Message;
                    }
                }
            }

            r.Objects.Sort(DumpObject.Compare);
            return r;
        }

        string WriteDump(string planet, string stamp, string json)
        {
            string dir = ResolveOutputDirectory();
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, SafeFileName(planet) + "-" + stamp + ".json");
            string tmp = file + ".tmp";
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            if (File.Exists(file))
            {
                File.Delete(file);
            }
            File.Move(tmp, file);
            return Path.GetFullPath(file);
        }

        string ResolveOutputDirectory()
        {
            string configured = (outputDirectory.Value ?? "").Trim();
            if (configured.Length == 0)
            {
                return Path.Combine(Paths.ConfigPath, "pcmap-dumps");
            }
            return Environment.ExpandEnvironmentVariables(configured);
        }

        // ------------------------------------------------------------------------------------------
        // Game-state readers
        // ------------------------------------------------------------------------------------------

        /// <summary>The current planet id, with "" mapped to "Prime", or null when no planet is loaded.</summary>
        static string CurrentPlanetId()
        {
            PlanetData pd = Managers.GetManager<PlanetLoader>()?.GetCurrentPlanetData();
            if (pd == null)
            {
                return null;
            }
            return string.IsNullOrEmpty(pd.id) ? "Prime" : pd.id;
        }

        static bool HasActivePlayer()
        {
            try
            {
                return Managers.GetManager<PlayersManager>()?.GetActivePlayerController() != null;
            }
            catch (Exception)
            {
                return false;
            }
        }

        static bool? ReadRandomizeMineables()
        {
            try
            {
                var gsh = Managers.GetManager<GameSettingsHandler>();
                if (gsh == null)
                {
                    return null;
                }
                return gsh.GetCurrentGameSettings().GetRandomizeMineables();
            }
            catch (Exception)
            {
                return null;
            }
        }

        void Notify(string text, bool warn = false)
        {
            if (warn)
            {
                Logger.LogWarning(text);
            }
            else
            {
                Logger.LogInfo(text);
            }
            try
            {
                Managers.GetManager<BaseHudHandler>()?.DisplayCursorText("", 6f, text);
            }
            catch (Exception)
            {
                // The HUD is optional. The log line above is the record.
            }
        }

        static bool IsFinite(float v)
        {
            return !float.IsNaN(v) && !float.IsInfinity(v);
        }

        static string SafeFileName(string s)
        {
            var invalid = Path.GetInvalidFileNameChars();
            var sb = new StringBuilder(s.Length);
            foreach (char c in s)
            {
                sb.Append(Array.IndexOf(invalid, c) >= 0 ? '_' : c);
            }
            return sb.Length == 0 ? "planet" : sb.ToString();
        }
    }

    sealed class SectorStats
    {
        public int Found;
        public int Loaded;
        public int AlreadyLoaded;
        public int Failed;
    }

    sealed class ScanResult
    {
        public readonly List<DumpObject> Objects = new List<DumpObject>(4096);
        public int Found;
        public int InInstance;
        public int NoGroup;
        public int Duplicates;
        public int BadPosition;
        public int Errors;
        public int OutsideSceneRange;
        public bool InstanceFilterActive;
        public string FirstError;
    }

    /// <summary>One `objects[]` entry. Coordinates are already rounded to 0.01. An Id of 0 means unknown (written as null).</summary>
    sealed class DumpObject
    {
        public readonly long Id;
        public readonly string GId;
        public readonly double X;
        public readonly double Y;
        public readonly double Z;

        public DumpObject(long id, string gId, double x, double y, double z)
        {
            Id = id;
            GId = gId;
            X = x;
            Y = y;
            Z = z;
        }

        /// <summary>Deterministic order: gId (ordinal), id, x, z, y.</summary>
        public static int Compare(DumpObject a, DumpObject b)
        {
            int c = string.CompareOrdinal(a.GId, b.GId);
            if (c != 0) return c;
            c = a.Id.CompareTo(b.Id);
            if (c != 0) return c;
            c = a.X.CompareTo(b.X);
            if (c != 0) return c;
            c = a.Z.CompareTo(b.Z);
            if (c != 0) return c;
            return a.Y.CompareTo(b.Y);
        }
    }

    /// <summary>
    /// Hand-written pcmap-dump/1 serializer. It has no JSON library dependency and uses the invariant
    /// culture throughout. It is kept free of Unity types so that it can be lifted into a plain .NET
    /// test project later.
    /// </summary>
    static class DumpJson
    {
        public static double Round2(float v)
        {
            double r = Math.Round((double)v, 2, MidpointRounding.AwayFromZero);
            return r == 0 ? 0 : r; // folds -0 into 0
        }

        public static string Build(string planet, string gameVersion, bool? randomizeMineables, string source,
            List<DumpObject> objects)
        {
            var sb = new StringBuilder(256 + objects.Count * 72);
            sb.Append("{\n");
            sb.Append("  \"format\": ").Append(Str(Plugin.DumpFormat)).Append(",\n");
            sb.Append("  \"planet\": ").Append(Str(planet)).Append(",\n");
            sb.Append("  \"gameVersion\": ").Append(gameVersion == null ? "null" : Str(gameVersion)).Append(",\n");
            sb.Append("  \"randomizeMineables\": ")
                .Append(randomizeMineables.HasValue ? (randomizeMineables.Value ? "true" : "false") : "null")
                .Append(",\n");
            sb.Append("  \"source\": ").Append(Str(source)).Append(",\n");
            sb.Append("  \"objects\": [");
            for (int i = 0; i < objects.Count; i++)
            {
                var o = objects[i];
                sb.Append(i == 0 ? "\n    " : ",\n    ");
                sb.Append("{\"id\": ").Append(o.Id > 0 ? o.Id.ToString(CultureInfo.InvariantCulture) : "null");
                sb.Append(", \"gId\": ").Append(Str(o.GId));
                sb.Append(", \"pos\": [").Append(Num(o.X)).Append(", ").Append(Num(o.Y)).Append(", ")
                    .Append(Num(o.Z)).Append("]}");
            }
            sb.Append(objects.Count == 0 ? "]\n" : "\n  ]\n");
            sb.Append("}\n");
            return sb.ToString();
        }

        /// <summary>A number already rounded to 2 decimals, without trailing zeros or an exponent, e.g. 12.5, -40.25, 3.</summary>
        static string Num(double v)
        {
            return v.ToString("0.##", CultureInfo.InvariantCulture);
        }

        /// <summary>A JSON string literal (RFC 8259 escaping, plus U+2028 and U+2029).</summary>
        internal static string Str(string s)
        {
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == '\u2028' || c == '\u2029')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
