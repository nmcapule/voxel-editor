import { record, invalid, stringValue, numberValue, booleanValue, oneOf } from '../validation'

export interface ViewSettings {
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
  projection: 'orthographic' | 'perspective'
  pathTracing: boolean
}

export const DEFAULT_SETTINGS: ViewSettings = {
  background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42,
  ambientOcclusion: true, shadows: true, grid: true, faceGrid: false,
  meshVertices: false, meshTriangles: false, projection: 'orthographic', pathTracing: true,
}

export function settingsPatch(value: unknown): Partial<ViewSettings> {
  const input = record(value, 'command.patch')
  const patch: Partial<ViewSettings> = {}
  const allowed = new Set(['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'meshVertices', 'meshTriangles', 'projection', 'pathTracing'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`Unknown setting: ${key}.`)
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
  if (input.pathTracing !== undefined) patch.pathTracing = booleanValue(input.pathTracing, 'command.patch.pathTracing')
  if (input.projection !== undefined) patch.projection = oneOf(input.projection, 'command.patch.projection', ['orthographic', 'perspective'] as const)
  if (!Object.keys(patch).length) throw invalid('command.patch must change at least one setting.')
  return patch
}

export function parseSettings(value: unknown): ViewSettings {
  const input = record(value, 'snapshot.settings')
  const patch = settingsPatch(input)
  const required = ['background', 'ambient', 'light', 'lightAzimuth', 'ambientOcclusion', 'shadows', 'grid', 'faceGrid', 'projection', 'pathTracing'] as const
  if (required.some(property => patch[property] === undefined)) throw invalid('snapshot.settings is incomplete.')
  return { meshVertices: false, meshTriangles: false, ...patch } as ViewSettings
}
