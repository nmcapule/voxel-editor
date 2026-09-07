import type { PaletteMaterial } from './document'
import { record, invalid, stringValue, numberValue } from '../validation'

export function materialPatch(value: unknown): Partial<PaletteMaterial> {
  const input = record(value, 'command.patch')
  const patch: Partial<PaletteMaterial> = {}
  const allowed = new Set(['name', 'roughness', 'metalness', 'emissiveIntensity', 'opacity', 'transmission', 'ior'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw invalid(`Unknown material property: ${key}.`)
  if (input.name !== undefined) patch.name = stringValue(input.name, 'command.patch.name', 40)
  if (input.roughness !== undefined) patch.roughness = numberValue(input.roughness, 'command.patch.roughness', 0, 1)
  if (input.metalness !== undefined) patch.metalness = numberValue(input.metalness, 'command.patch.metalness', 0, 1)
  if (input.emissiveIntensity !== undefined) patch.emissiveIntensity = numberValue(input.emissiveIntensity, 'command.patch.emissiveIntensity', 0, 5)
  if (input.opacity !== undefined) patch.opacity = numberValue(input.opacity, 'command.patch.opacity', 0, 1)
  if (input.transmission !== undefined) patch.transmission = numberValue(input.transmission, 'command.patch.transmission', 0, 1)
  if (input.ior !== undefined) patch.ior = numberValue(input.ior, 'command.patch.ior', 1, 2.5)
  if (!Object.keys(patch).length) throw invalid('command.patch must change at least one material property.')
  return patch
}
