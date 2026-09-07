import * as THREE from 'three'
import type { Vector3Value as Vec3 } from './contracts'
const axisNames = ['x', 'y', 'z'] as const

export function castsRealtimeShadow(material: { opacity: number; transmission: number }) {
  return material.opacity >= 1 && material.transmission === 0
}

/** Conservative directional-shadow demand: camera-clipped receivers in light XY,
 * extended toward the light through occupied scene depth. Polygon clipping handles
 * horizon crossings and negative orthographic near planes without ground-ray divides.
 * worldToLight uses the shadow camera convention (+Z points toward the light).
 */
export function sceneShadowVolume(camera: THREE.Camera, occupied: THREE.Box3, receivers: Iterable<THREE.Box3>, worldToLight: THREE.Matrix4, groundY?: number, margin = 0, groundBounds?: THREE.Box3) {
  if (occupied.isEmpty()) return
  camera.updateMatrixWorld(true)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
  const lightBounds = new THREE.Box3(), point = new THREE.Vector3()
  const include = (points: THREE.Vector3[]) => {
    for (const vertex of points) lightBounds.expandByPoint(point.copy(vertex).applyMatrix4(worldToLight))
  }
  const clip = (polygon: THREE.Vector3[]) => {
    for (const plane of frustum.planes) {
      const result: THREE.Vector3[] = []
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length]
        const da = plane.distanceToPoint(a) + 1e-7, db = plane.distanceToPoint(b) + 1e-7
        if (da >= 0) result.push(a)
        if ((da >= 0) !== (db >= 0)) result.push(a.clone().lerp(b, da / (da - db)))
      }
      polygon = result
      if (!polygon.length) break
    }
    return polygon
  }
  const corners = (bounds: THREE.Box3) => Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
    i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z))
  const viewCorners = corners(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))).map(p => p.unproject(camera))
  for (const bounds of receivers) {
    if (bounds.isEmpty() || !frustum.intersectsBox(bounds)) continue
    const vertices = corners(bounds)
    if (vertices.every(p => frustum.containsPoint(p))) { include(vertices); continue }
    for (const face of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) include(clip(face.map(i => vertices[i])))
    // A receiver can contain the frustum without any receiver corner being visible.
    include(viewCorners.filter(p => bounds.containsPoint(p)))
  }
  if (groundY !== undefined && (camera instanceof THREE.PerspectiveCamera
    ? camera.getWorldPosition(point).y > groundY : camera.getWorldDirection(point).y < 0)) {
    const footprint = occupied.clone(), light = worldToLight.elements
    footprint.min.y = footprint.max.y = groundY
    // Shadows can land outside the occupied XZ box. Bound ground receivers by the
    // occupied scene's projected shadow footprint, then by the finite stage floor.
    if (light[6] > 1e-8) for (const vertex of corners(occupied)) {
      const distance = (vertex.y - groundY) / light[6]
      footprint.expandByPoint(point.set(vertex.x - light[2] * distance, groundY, vertex.z - light[10] * distance))
    }
    if (groundBounds) {
      footprint.min.x = Math.max(footprint.min.x, groundBounds.min.x); footprint.max.x = Math.min(footprint.max.x, groundBounds.max.x)
      footprint.min.z = Math.max(footprint.min.z, groundBounds.min.z); footprint.max.z = Math.min(footprint.max.z, groundBounds.max.z)
    }
    if (!footprint.isEmpty()) include(clip([
      new THREE.Vector3(footprint.min.x, groundY, footprint.min.z), new THREE.Vector3(footprint.max.x, groundY, footprint.min.z),
      new THREE.Vector3(footprint.max.x, groundY, footprint.max.z), new THREE.Vector3(footprint.min.x, groundY, footprint.max.z),
    ]))
  }
  if (lightBounds.isEmpty()) return
  const padding = Math.max(0, margin) + 1e-5
  lightBounds.expandByScalar(padding)
  lightBounds.max.z = Math.max(lightBounds.max.z, occupied.clone().applyMatrix4(worldToLight).max.z + padding)
  const { min, max } = lightBounds
  if (![...min.toArray(), ...max.toArray()].every(Number.isFinite)) throw new Error('Cannot determine shadow demand from a non-finite camera/light transform.')
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
    .makeOrthographic(min.x, max.x, max.y, min.y, -max.z, -min.z).multiply(worldToLight))
}

export function realtimeEnvironmentIntensity(metalness: number) {
  return 0.2 + metalness * 0.5
}

export function workspaceGridPositions(dimensions: Vec3, normal: Vec3 = { x: 0, y: 1, z: 0 }) {
  const positions: number[] = []
  const axis = axisNames.find(name => normal[name]) ?? 'y'
  const [u, v] = axisNames.filter(name => name !== axis)
  const fixed = normal[axis] < 0 ? dimensions[axis] : 0
  const push = (uValue: number, vValue: number) => {
    const cell = { x: 0, y: 0, z: 0, [axis]: fixed, [u]: uValue, [v]: vValue }
    positions.push(cell.x - dimensions.x / 2, cell.y, cell.z - dimensions.z / 2)
  }
  for (let value = 0; value <= dimensions[u]; value++) { push(value, 0); push(value, dimensions[v]) }
  for (let value = 0; value <= dimensions[v]; value++) { push(0, value); push(dimensions[u], value) }
  return new Float32Array(positions)
}

export function workspaceGridPlaneVisible(dimensions: Vec3, normal: Vec3, camera: Vec3) {
  const axis = axisNames.find(name => normal[name])
  if (!axis || axis === 'y') return true
  const boundary = normal[axis] > 0 ? -dimensions[axis] / 2 : dimensions[axis] / 2
  return (camera[axis] - boundary) * normal[axis] >= 0
}