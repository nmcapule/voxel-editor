import { StudioCommandError } from './errors'
import type { Dimensions, Vec3 } from './voxel/document'

export const MAX_BINARY_BYTES = 72 * 1024 * 1024

export type RecordValue = Record<string, unknown>

export function record(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(`${name} must be an object.`)
  return value as RecordValue
}

export function invalid(message: string): StudioCommandError {
  return new StudioCommandError('invalid_argument', message)
}

export function stringValue(value: unknown, name: string, max: number, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.trim()) throw invalid(`${name} must be a${allowEmpty ? '' : ' non-empty'} string up to ${max} characters.`)
  return value
}

export function numberValue(value: unknown, name: string, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(`${name} must be a finite number from ${min} to ${max}.`)
  return value
}

export function integer(value: unknown, name: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const result = numberValue(value, name, min, max)
  if (!Number.isInteger(result)) throw invalid(`${name} must be an integer.`)
  return result
}

export function booleanValue(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw invalid(`${name} must be a boolean.`)
  return value
}

export function oneOf<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw invalid(`${name} must be one of: ${values.join(', ')}.`)
  return value as T
}

export function optional<T>(value: unknown, parse: (value: unknown) => T) {
  return value === undefined ? undefined : parse(value)
}

export function vec3(value: unknown, name: string): Vec3 {
  const input = record(value, name)
  return { x: integer(input.x, `${name}.x`), y: integer(input.y, `${name}.y`), z: integer(input.z, `${name}.z`) }
}

export function dimensions(value: unknown, name: string): Dimensions {
  const input = record(value, name)
  return { x: integer(input.x, `${name}.x`, 16, 256), y: integer(input.y, `${name}.y`, 16, 256), z: integer(input.z, `${name}.z`, 16, 256) }
}

export function base64(value: unknown, name: string, maxBytes = MAX_BINARY_BYTES) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid(`${name} must be valid base64 within the size limit.`)
  return value
}
