// Consistency checks for the C# dumper. The plugin itself cannot be built here (it needs the
// proprietary game DLLs), so these tests guard the hand-synced constants and the documented output shape.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNTIME_ID_MIN, SCENE_ID_MIN, isSceneId } from '../../src/lib/planets.js'

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
const plugin = read('./Plugin.cs')
const csproj = read('./PCMapDumper.csproj')
const readme = read('./README.md')

/** @param {string} name C# const name @returns {string} its initializer text */
const csConst = (name) => {
  const m = plugin.match(new RegExp(`const\\s+\\w+\\s+${name}\\s*=\\s*([^;]+);`))
  if (!m) throw new Error(`const ${name} not found in Plugin.cs`)
  return m[1].trim()
}

const version = JSON.parse(csConst('PluginVersion'))

describe('tools/dumper', () => {
  it('writes the pcmap-dump/1 format tag', () => {
    expect(csConst('DumpFormat')).toBe('"pcmap-dump/1"')
  })

  it('keeps the plugin version in sync with the csproj and the source tag', () => {
    expect(csproj).toContain(`<Version>${version}</Version>`)
    expect(csConst('Source')).toBe('"pcmap-dumper " + PluginVersion')
  })

  it('mirrors the scene id range of src/lib/planets.js', () => {
    expect(Number(csConst('SceneIdMin').replace(/_/g, ''))).toBe(SCENE_ID_MIN)
    expect(Number(csConst('RuntimeIdMin').replace(/_/g, ''))).toBe(RUNTIME_ID_MIN)
  })

  it('serializes the contract keys in contract order', () => {
    const build = plugin.slice(plugin.indexOf('public static string Build('))
    const keys = [...build.matchAll(/\\"(\w+)\\": /g)].map((m) => m[1])
    expect(keys).toEqual(['format', 'planet', 'gameVersion', 'randomizeMineables', 'source', 'objects', 'id', 'gId', 'pos'])
  })

  it('keeps Plugin.cs pure ASCII, so no raw U+2028/U+2029 ends up in a C# literal', () => {
    const nonAscii = plugin.split('\n').flatMap((line, i) => (/[^\x00-\x7F]/.test(line) ? [i + 1] : []))
    expect(nonAscii).toEqual([])
    expect(plugin).toContain("c == '\\u2028' || c == '\\u2029'")
  })

  it('documents the hotkey, the output folder and the HideManagerGameObject requirement', () => {
    expect(csConst('DefaultKey')).toBe('"<Keyboard>/f9"')
    expect(plugin).toMatch(/Config\.Bind\("Hotkey", "RequireCtrl", true,/)
    expect(plugin).toMatch(/Config\.Bind\("Hotkey", "RequireShift", true,/)
    expect(readme).toContain('**Ctrl+Shift+F9**')
    expect(plugin).toContain('Path.Combine(Paths.ConfigPath, "pcmap-dumps")')
    expect(readme).toContain('`<GameDir>/BepInEx/config/pcmap-dumps/<Planet>-<yyyyMMdd-HHmmss>.json`')
    expect(readme).toContain('**`HideManagerGameObject = true`** in `<GameDir>/BepInEx/config/BepInEx.cfg`')
    const awake = plugin.slice(plugin.indexOf('void Awake()'), plugin.indexOf('void BindKey()'))
    expect(awake).toContain('if ((gameObject.hideFlags & HideFlags.HideAndDontSave) == 0)')
    expect(awake).toMatch(/LogWarning\("HideManagerGameObject is false/)
  })

  it('accounts for the Awake() hideFlags self-check in the API verification section', () => {
    const section = readme.slice(readme.indexOf('## API verification'), readme.indexOf('## License'))
    expect(plugin).toContain('gameObject.hideFlags & HideFlags.HideAndDontSave')
    expect(section).toContain('`(gameObject.hideFlags & HideFlags.HideAndDontSave) == 0`')
    expect(section).toContain('`Chainloader.ManagerObject`')
  })

  it('documents a synthetic output example with the contract shape', () => {
    const example = JSON.parse(readme.match(/```json\n([\s\S]*?)```/)[1])
    expect(Object.keys(example)).toEqual(['format', 'planet', 'gameVersion', 'randomizeMineables', 'source', 'objects'])
    expect(example.format).toBe('pcmap-dump/1')
    expect(example.source).toBe(`pcmap-dumper ${version}`)
    expect(example.objects.length).toBeGreaterThan(0)
    for (const o of example.objects) {
      expect(Object.keys(o)).toEqual(['id', 'gId', 'pos'])
      expect(o.id === null || isSceneId(o.id)).toBe(true)
      expect(o.pos).toHaveLength(3)
      for (const v of o.pos) expect(Math.round(v * 100) / 100).toBe(v)
    }
  })
})
