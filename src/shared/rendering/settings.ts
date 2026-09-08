import { record, invalid, stringValue, numberValue, booleanValue, oneOf } from '../validation'

export const SKYBOX_PRESETS = {
  solid: 'Solid color',
  daylight: 'Daylight',
  overcast: 'Overcast',
  sunset: 'Sunset',
  night: 'Night',
} as const

export type SkyboxPreset = keyof typeof SKYBOX_PRESETS

export interface ViewSettings {
  skybox: SkyboxPreset
  background: string
  ambient: number
  light: number
  lightAzimuth: number
  ambientOcclusion: boolean
  shadows: boolean
  grid: boolean
  faceGrid: boolean
  meshVertices: boolean
  meshTriangles: boolean
  previewRenderer: 'standard' | 'cube-sprites'
  pbrMaterials: boolean
  projection: 'orthographic' | 'perspective'
  pathTracing: boolean
  tiltShift: boolean
  tiltShiftStrength: number
  tiltShiftFocus: number
  tiltShiftWidth: number
}

export const DEFAULT_SETTINGS: ViewSettings = {
  skybox: 'solid', background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42,
  ambientOcclusion: true, shadows: true, grid: true, faceGrid: false,
  meshVertices: false, meshTriangles: false, previewRenderer: 'standard', pbrMaterials: true, projection: 'orthographic', pathTracing: true,
  tiltShift: false, tiltShiftStrength: 0.5, tiltShiftFocus: 0.5, tiltShiftWidth: 0.3,
}

export function settingsPatch(value: unknown): Partial<ViewSettings> {
  const input = record(value, 'command.patch')
  const patch: Partial<ViewSettings> = {}
  const allowed = new Set([...Object.keys(DEFAULT_SETTINGS), 'cubeSpritesPbr'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`Unknown setting: ${key}.`)
  if (input.skybox !== undefined) patch.skybox = oneOf(input.skybox, 'command.patch.skybox', Object.keys(SKYBOX_PRESETS) as SkyboxPreset[])
  if (input.background !== undefined) {
    const background = stringValue(input.background, 'command.patch.background', 7)
    if (!/^#[0-9a-f]{6}$/i.test(background)) throw invalid('command.patch.background must be a six-digit hex color.')
    patch.background = background
  }
  if (input.ambient !== undefined) patch.ambient = numberValue(input.ambient, 'command.patch.ambient', 0, 3)
  if (input.light !== undefined) patch.light = numberValue(input.light, 'command.patch.light', 0, 5)
  if (input.lightAzimuth !== undefined) patch.lightAzimuth = numberValue(input.lightAzimuth, 'command.patch.lightAzimuth', -180, 180)
  if (input.ambientOcclusion !== undefined) patch.ambientOcclusion = booleanValue(input.ambientOcclusion, 'command.patch.ambientOcclusion')
  if (input.shadows !== undefined) patch.shadows = booleanValue(input.shadows, 'command.patch.shadows')
  if (input.grid !== undefined) patch.grid = booleanValue(input.grid, 'command.patch.grid')
  if (input.faceGrid !== undefined) patch.faceGrid = booleanValue(input.faceGrid, 'command.patch.faceGrid')
  if (input.meshVertices !== undefined) patch.meshVertices = booleanValue(input.meshVertices, 'command.patch.meshVertices')
  if (input.meshTriangles !== undefined) patch.meshTriangles = booleanValue(input.meshTriangles, 'command.patch.meshTriangles')
  if (input.previewRenderer !== undefined) patch.previewRenderer = oneOf(input.previewRenderer, 'command.patch.previewRenderer', ['standard', 'cube-sprites'] as const)
  if (input.pbrMaterials !== undefined) patch.pbrMaterials = booleanValue(input.pbrMaterials, 'command.patch.pbrMaterials')
  if (input.cubeSpritesPbr !== undefined) {
    const legacyPbr = booleanValue(input.cubeSpritesPbr, 'command.patch.cubeSpritesPbr')
    if (patch.pbrMaterials !== undefined && patch.pbrMaterials !== legacyPbr) throw invalid('command.patch.pbrMaterials and cubeSpritesPbr must not conflict.')
    patch.pbrMaterials = legacyPbr
  }
  if (input.pathTracing !== undefined) patch.pathTracing = booleanValue(input.pathTracing, 'command.patch.pathTracing')
  if (input.tiltShift !== undefined) patch.tiltShift = booleanValue(input.tiltShift, 'command.patch.tiltShift')
  for (const key of ['tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth'] as const) {
    if (input[key] !== undefined) patch[key] = numberValue(input[key], `command.patch.${key}`, 0, 1)
  }
  if (input.projection !== undefined) patch.projection = oneOf(input.projection, 'command.patch.projection', ['orthographic', 'perspective'] as const)
  if (!Object.keys(patch).length) throw invalid('command.patch must change at least one setting.')
  return patch
}

export function parseSettings(value: unknown): ViewSettings {
  const { cubeSpritesPbr, ...input } = record(value, 'snapshot.settings')
  const legacyPbr = cubeSpritesPbr === undefined ? false : booleanValue(cubeSpritesPbr, 'snapshot.settings.cubeSpritesPbr')
  // Saved Standard rendering was always physical; only Cube sprites used the legacy flag.
  const patch = settingsPatch({ ...input, pbrMaterials: input.pbrMaterials !== undefined ? input.pbrMaterials
    : input.previewRenderer === 'cube-sprites' ? legacyPbr : true })
  const required = ['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'projection', 'pathTracing'] as const
  if (required.some(property => patch[property] === undefined)) throw invalid('snapshot.settings is incomplete.')
  return { ...DEFAULT_SETTINGS, ...patch }
}
