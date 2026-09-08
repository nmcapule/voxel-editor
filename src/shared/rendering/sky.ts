import * as THREE from 'three'
import type { SkyboxPreset } from './settings'

export const SKY_LIGHTING = {
  daylight: { zenith: '#3779cc', horizon: '#d9efff', nadir: '#818b94', keyColor: '#fff4df', elevation: 50, keyStrength: 1, radiance: 2, glow: 0.8 },
  overcast: { zenith: '#bec9d5', horizon: '#e0e4e8', nadir: '#858b93', keyColor: '#edf3ff', elevation: 60, keyStrength: 0.05, radiance: 1.5, glow: 0.08 },
  sunset: { zenith: '#465884', horizon: '#e4a77e', nadir: '#51444d', keyColor: '#ffb66e', elevation: 10, keyStrength: 0.5, radiance: 1.5, glow: 1.2 },
  night: { zenith: '#121b3a', horizon: '#465777', nadir: '#182035', keyColor: '#b8ceff', elevation: 35, keyStrength: 0.03, radiance: 0.65, glow: 0.08 },
} as const

const colors = Object.fromEntries(Object.entries(SKY_LIGHTING).map(([id, sky]) => [id, {
  zenith: new THREE.Color(sky.zenith), horizon: new THREE.Color(sky.horizon), nadir: new THREE.Color(sky.nadir), key: new THREE.Color(sky.keyColor),
}])) as Record<Exclude<SkyboxPreset, 'solid'>, { zenith: THREE.Color; horizon: THREE.Color; nadir: THREE.Color; key: THREE.Color }>

/** Linear radiance in a normalized world direction, before the authored azimuth rotation. */
export function skyColor(preset: Exclude<SkyboxPreset, 'solid'>, direction: THREE.Vector3, target = new THREE.Color()) {
  const sky = SKY_LIGHTING[preset], palette = colors[preset]
  const elevation = THREE.MathUtils.degToRad(sky.elevation)
  // A broad glow gives reflection detail without a second, noisy high-energy sun.
  const glow = Math.max(0, direction.x * Math.cos(elevation) + direction.y * Math.sin(elevation)) ** 48 * sky.glow
  target.copy(palette.horizon).lerp(direction.y >= 0 ? palette.zenith : palette.nadir, Math.sqrt(Math.abs(direction.y)))
  target.r += palette.key.r * glow
  target.g += palette.key.g * glow
  target.b += palette.key.b * glow
  return target.multiplyScalar(sky.radiance)
}

export function createSkyTexture(preset: Exclude<SkyboxPreset, 'solid'>) {
  const width = 256, height = 128, pixels = new Uint16Array(width * height * 4)
  const direction = new THREE.Vector3(), color = new THREE.Color()
  for (let y = 0; y < height; y++) {
    const theta = (y + 0.5) / height * Math.PI
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2
      direction.set(Math.sin(theta) * Math.cos(phi), -Math.cos(theta), Math.sin(theta) * Math.sin(phi))
      skyColor(preset, direction, color)
      const offset = (y * width + x) * 4
      pixels[offset] = THREE.DataUtils.toHalfFloat(color.r)
      pixels[offset + 1] = THREE.DataUtils.toHalfFloat(color.g)
      pixels[offset + 2] = THREE.DataUtils.toHalfFloat(color.b)
      pixels[offset + 3] = THREE.DataUtils.toHalfFloat(1)
    }
  }
  // Half-float linear filtering is core WebGL2, unlike FloatType's optional extension.
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.HalfFloatType)
  texture.name = preset
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.LinearSRGBColorSpace
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.needsUpdate = true
  return texture
}
