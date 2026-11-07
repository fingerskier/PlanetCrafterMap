// PCMapDumper: part of PlanetCrafterMap (tools/dumper).
// Copyright (c) 2026 PlanetCrafterMap contributors. Licensed under the Apache License, Version 2.0.
//
// Samples the loaded planet's ground height on a regular X/Z grid and writes a `pcmap-heights/1` file, from
// which the map's build renders a shaded-relief basemap. Only numbers leave the game: no textures, meshes or
// screenshots. Format (docs/ARCHITECTURE.md):
//
//   gzip( <one line of UTF-8 JSON header> "\n" <channel 0> <channel 1> ... )
//
// Each channel is width*height little-endian Int16 values, row-major, row 0 at minZ, column 0 at minX,
// in decimetres (value * 0.1 = metres). -32768 means "no sample".
//   terrain: the highest Unity Terrain (inactive ones included) under the cell centre.
//   surface: the first collider hit by a ray cast straight down (triggers ignored): rocks, cliffs, props.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;
using UnityEngine;

namespace PCMapDumper
{
    sealed class HeightsResult
    {
        public double MinX;
        public double MinZ;
        public double Step;
        public int Width;
        public int Height;
        public short[] Terrain;
        public short[] Surface;
        public int Terrains;
        public int TerrainSamples;
        public int SurfaceSamples;
    }

    static class Heights
    {
        public const string Format = "pcmap-heights/1";
        public const short NoData = short.MinValue;

        /// <summary>The XZ region to sample: the union of all terrains, else the objects' extent, padded.</summary>
        public static bool Region(List<Terrain> terrains, List<DumpObject> objects, out Rect rect, out string how)
        {
            bool any = false;
            float x0 = 0, z0 = 0, x1 = 0, z1 = 0;
            foreach (var t in terrains)
            {
                var size = t.terrainData.size;
                var p = t.transform.position;
                Grow(ref any, ref x0, ref z0, ref x1, ref z1, p.x, p.z);
                Grow(ref any, ref x0, ref z0, ref x1, ref z1, p.x + size.x, p.z + size.z);
            }
            how = "terrains";
            if (!any)
            {
                foreach (var o in objects)
                {
                    Grow(ref any, ref x0, ref z0, ref x1, ref z1, (float)o.X, (float)o.Z);
                }
                how = "objects";
                if (any)
                {
                    x0 -= 200; z0 -= 200; x1 += 200; z1 += 200;
                }
            }
            rect = any ? Rect.MinMaxRect(x0, z0, x1, z1) : default;
            return any && rect.width > 0 && rect.height > 0;
        }

        static void Grow(ref bool any, ref float x0, ref float z0, ref float x1, ref float z1, float x, float z)
        {
            if (!any)
            {
                x0 = x1 = x;
                z0 = z1 = z;
                any = true;
                return;
            }
            x0 = Math.Min(x0, x);
            z0 = Math.Min(z0, z);
            x1 = Math.Max(x1, x);
            z1 = Math.Max(z1, z);
        }

        /// <summary>Sample both channels. Yields between frames so the game keeps drawing; progress goes to `progress`.</summary>
        public static IEnumerator Sample(List<Terrain> terrains, Rect rect, double step, int maxCells, float rayTop,
            float rayLength, Action<string> progress, Action<HeightsResult> done)
        {
            // The exact grid that will be allocated: origin snapped down to a multiple of the step, far edge rounded up.
            double minX, minZ;
            long width, height;
            while (true)
            {
                minX = Math.Floor(rect.xMin / step) * step;
                minZ = Math.Floor(rect.yMin / step) * step;
                width = (long)Math.Ceiling((rect.xMax - minX) / step) + 1;
                height = (long)Math.Ceiling((rect.yMax - minZ) / step) + 1;
                if (width * height <= maxCells)
                {
                    break;
                }
                step *= 2;
            }
            var r = new HeightsResult
            {
                MinX = minX,
                MinZ = minZ,
                Step = step,
                Terrains = terrains.Count,
                Width = (int)width,
                Height = (int)height,
            };
            int n = r.Width * r.Height;
            r.Terrain = new short[n];
            r.Surface = new short[n];
            for (int i = 0; i < n; i++)
            {
                r.Terrain[i] = NoData;
                r.Surface[i] = NoData;
            }

            var clock = Stopwatch.StartNew();
            const long FrameBudgetMs = 40;

            // Terrain heights: per terrain, only the cells it covers. Overlaps keep the highest.
            foreach (var t in terrains)
            {
                var td = t.terrainData;
                var size = td.size;
                var p = t.transform.position;
                int cx0 = Math.Max(0, (int)Math.Ceiling((p.x - r.MinX) / step));
                int cx1 = Math.Min(r.Width - 1, (int)Math.Floor((p.x + size.x - r.MinX) / step));
                int cz0 = Math.Max(0, (int)Math.Ceiling((p.z - r.MinZ) / step));
                int cz1 = Math.Min(r.Height - 1, (int)Math.Floor((p.z + size.z - r.MinZ) / step));
                for (int cz = cz0; cz <= cz1; cz++)
                {
                    double wz = r.MinZ + cz * step;
                    float nz = Mathf.Clamp01((float)((wz - p.z) / size.z));
                    for (int cx = cx0; cx <= cx1; cx++)
                    {
                        double wx = r.MinX + cx * step;
                        float nx = Mathf.Clamp01((float)((wx - p.x) / size.x));
                        float h = p.y + td.GetInterpolatedHeight(nx, nz);
                        short v = Encode(h);
                        int i = cz * r.Width + cx;
                        if (v != NoData && (r.Terrain[i] == NoData || v > r.Terrain[i]))
                        {
                            r.Terrain[i] = v;
                        }
                    }
                    if (clock.ElapsedMilliseconds > FrameBudgetMs)
                    {
                        yield return null;
                        clock.Restart();
                    }
                }
            }

            // Surface heights: one ray per cell.
            Physics.SyncTransforms();
            int lastPct = -1;
            for (int cz = 0; cz < r.Height; cz++)
            {
                double wz = r.MinZ + cz * step;
                for (int cx = 0; cx < r.Width; cx++)
                {
                    double wx = r.MinX + cx * step;
                    var origin = new Vector3((float)wx, rayTop, (float)wz);
                    if (Physics.Raycast(origin, Vector3.down, out var hit, rayLength, Physics.DefaultRaycastLayers,
                            QueryTriggerInteraction.Ignore))
                    {
                        r.Surface[cz * r.Width + cx] = Encode(hit.point.y);
                    }
                }
                int pct = (int)(100L * (cz + 1) / r.Height);
                if (pct / 10 != lastPct / 10)
                {
                    lastPct = pct;
                    progress("PCMap heights: " + pct + "%");
                }
                if (clock.ElapsedMilliseconds > FrameBudgetMs)
                {
                    yield return null;
                    clock.Restart();
                }
            }

            for (int i = 0; i < n; i++)
            {
                if (r.Terrain[i] != NoData) r.TerrainSamples++;
                if (r.Surface[i] != NoData) r.SurfaceSamples++;
            }
            done(r);
        }

        /// <summary>Metres to decimetres, or NoData when not finite or out of range.</summary>
        public static short Encode(float metres)
        {
            if (float.IsNaN(metres) || float.IsInfinity(metres))
            {
                return NoData;
            }
            double dm = Math.Round(metres * 10.0, MidpointRounding.AwayFromZero);
            if (dm <= short.MinValue || dm > short.MaxValue)
            {
                return NoData;
            }
            return (short)dm;
        }

        public static string Header(string planet, string gameVersion, string source, HeightsResult r)
        {
            var c = CultureInfo.InvariantCulture;
            var sb = new StringBuilder(256);
            sb.Append("{\"format\": ").Append(DumpJson.Str(Format));
            sb.Append(", \"planet\": ").Append(DumpJson.Str(planet));
            sb.Append(", \"gameVersion\": ").Append(gameVersion == null ? "null" : DumpJson.Str(gameVersion));
            sb.Append(", \"source\": ").Append(DumpJson.Str(source));
            sb.Append(", \"minX\": ").Append(r.MinX.ToString("0.###", c));
            sb.Append(", \"minZ\": ").Append(r.MinZ.ToString("0.###", c));
            sb.Append(", \"step\": ").Append(r.Step.ToString("0.###", c));
            sb.Append(", \"width\": ").Append(r.Width.ToString(c));
            sb.Append(", \"height\": ").Append(r.Height.ToString(c));
            sb.Append(", \"scale\": 0.1, \"nodata\": -32768, \"channels\": [\"terrain\", \"surface\"]}");
            return sb.ToString();
        }

        public static string Write(string dir, string baseName, string header, HeightsResult r)
        {
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, baseName + ".heights.gz");
            string tmp = file + ".tmp";
            using (var fs = File.Create(tmp))
            using (var gz = new GZipStream(fs, System.IO.Compression.CompressionLevel.Optimal))
            {
                var head = new UTF8Encoding(false).GetBytes(header + "\n");
                gz.Write(head, 0, head.Length);
                WriteChannel(gz, r.Terrain);
                WriteChannel(gz, r.Surface);
            }
            if (File.Exists(file))
            {
                File.Delete(file);
            }
            File.Move(tmp, file);
            return Path.GetFullPath(file);
        }

        static void WriteChannel(Stream s, short[] values)
        {
            var buf = new byte[values.Length * 2];
            for (int i = 0; i < values.Length; i++)
            {
                ushort u = unchecked((ushort)values[i]);
                buf[2 * i] = (byte)(u & 0xff);
                buf[2 * i + 1] = (byte)(u >> 8);
            }
            s.Write(buf, 0, buf.Length);
        }
    }
}
