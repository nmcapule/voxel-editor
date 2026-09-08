import * as THREE from 'three'
import type { SkyboxPreset } from './settings'

export const SKY_LIGHTING = {
  daylight: { zenith: '#3779cc', horizon: '#d9efff', nadir: '#818b94', keyColor: '#fff4df', elevation: 50, keyStrength: 1, radiance: 1.5, glow: 0.6 },
  overcast: { zenith: '#bec9d5', horizon: '#e0e4e8', nadir: '#858b93', keyColor: '#edf3ff', elevation: 60, keyStrength: 0.05, radiance: 1.5, glow: 0.08 },
  sunset: { zenith: '#465884', horizon: '#e4a77e', nadir: '#51444d', keyColor: '#ffb66e', elevation: 10, keyStrength: 0.5, radiance: 1.5, glow: 1.2 },
  night: { zenith: '#152444', horizon: '#5d7398', nadir: '#26364c', keyColor: '#cbdcff', elevation: 35, keyStrength: 0.65, radiance: 1.1, glow: 0.35 },
} as const

const landscape = {
  daylight: { cloud: '#f3f1e7', far: '#82999e', near: '#496d6a', trees: '#254638', ground: '#3b5140' },
  overcast: { cloud: '#e1e6e8', far: '#859397', near: '#52696a', trees: '#2d4540', ground: '#3d5149' },
  sunset: { cloud: '#f4bb91', far: '#8a7885', near: '#5d566e', trees: '#333345', ground: '#46404c' },
  night: { cloud: '#7389b0', far: '#3a4c6a', near: '#293c52', trees: '#172a38', ground: '#26394b' },
} as const

const colors = Object.fromEntries(Object.entries(SKY_LIGHTING).map(([id, sky]) => [id, {
  zenith: new THREE.Color(sky.zenith), horizon: new THREE.Color(sky.horizon), nadir: new THREE.Color(sky.nadir), key: new THREE.Color(sky.keyColor),
  ...Object.fromEntries(Object.entries(landscape[id as keyof typeof landscape]).map(([key, value]) => [key, new THREE.Color(value)])),
}])) as Record<Exclude<SkyboxPreset, 'solid'>, Record<'zenith' | 'horizon' | 'nadir' | 'key' | 'cloud' | 'far' | 'near' | 'trees' | 'ground', THREE.Color>>

function hash(x: number, y = 0, z = 0) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177)
  n = Math.imul(n ^ n >>> 13, 1274126177)
  return ((n ^ n >>> 16) >>> 0) / 4294967295
}

function noise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  x -= ix; y -= iy; z -= iz
  x *= x * (3 - 2 * x); y *= y * (3 - 2 * y); z *= z * (3 - 2 * z)
  const mix = THREE.MathUtils.lerp
  return mix(mix(mix(hash(ix, iy, iz), hash(ix + 1, iy, iz), x), mix(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), x), y),
    mix(mix(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), x), mix(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), x), y), z)
}

/** Periodic angular terrain: the panorama seam shares the same ridge and tree seeds. */
function ridge(u: number, count: number, seed: number) {
  const p = u * count, i = Math.floor(p), t = p - i
  return THREE.MathUtils.lerp(hash((i % count + count) % count, seed), hash(((i + 1) % count + count) % count, seed), t)
}

/** Linear radiance in a normalized world direction, before the authored azimuth rotation. */
export function skyColor(preset: Exclude<SkyboxPreset, 'solid'>, direction: THREE.Vector3, target = new THREE.Color()) {
  const sky = SKY_LIGHTING[preset], palette = colors[preset]
  const elevation = THREE.MathUtils.degToRad(sky.elevation)
  // A broad glow gives reflection detail without a second, noisy high-energy sun.
  const alignment = Math.max(0, direction.x * Math.cos(elevation) + direction.y * Math.sin(elevation))
  const glow = alignment ** 48 * sky.glow
  target.copy(palette.horizon).lerp(direction.y >= 0 ? palette.zenith : palette.nadir, Math.sqrt(Math.abs(direction.y)))

  if (direction.y > -0.04) {
    const x = direction.x * 5, y = direction.y * 7 + 11, z = direction.z * 5
    const cloudNoise = noise(x, y, z) * 0.6 + noise(x * 2.1, y * 2.1, z * 2.1) * 0.27 + noise(x * 4.3, y * 4.3, z * 4.3) * 0.13
    const coverage = THREE.MathUtils.smoothstep(cloudNoise, preset === 'overcast' ? 0.32 : 0.48, 0.72)
      * THREE.MathUtils.smoothstep(direction.y, -0.04, 0.12)
    target.lerp(palette.cloud, coverage * (preset === 'night' ? 0.55 : 0.88))
  }
  target.r += palette.key.r * glow
  target.g += palette.key.g * glow
  target.b += palette.key.b * glow

  if (preset === 'night') {
    // A bounded, softly edged lunar disk and halo; the directional light illuminates models.
    const moon = THREE.MathUtils.smoothstep(alignment, Math.cos(0.038), Math.cos(0.025))
    target.r += palette.key.r * moon * 2
    target.g += palette.key.g * moon * 2
    target.b += palette.key.b * moon * 2
  }

  const u = Math.atan2(direction.z, direction.x) / (Math.PI * 2) + 0.5
  const far = 0.045 + ridge(u, 20, 7) * 0.22 + ridge(u, 59, 9) * 0.055
  const near = -0.018 + ridge(u, 9, 17) * 0.08 + ridge(u, 29, 19) * 0.036
  const treeLine = -0.07 + ridge(u, 17, 31) * 0.032
  if (direction.y < far) target.copy(palette.far).lerp(palette.horizon, THREE.MathUtils.smoothstep(direction.y, 0, far) * 0.22)
  if (direction.y < near) target.copy(palette.near).multiplyScalar(0.9 + ridge(u, 71, 23) * 0.2)
  if (direction.y < treeLine) {
    target.copy(palette.ground).lerp(palette.trees, noise(direction.x * 35, direction.y * 7, direction.z * 35) * 0.4)
  } else if (direction.y < treeLine + 0.09) {
    const cell = u * 120, index = (Math.floor(cell) % 120 + 120) % 120
    const distance = Math.abs(cell - Math.floor(cell) - 0.5 - (hash(index, 39) - 0.5) * 0.14)
    const height = 0.028 + hash(index, 41) * 0.055
    if (hash(index, 43) > 0.12) {
      let tree = distance < 0.022 && direction.y < treeLine + height * 0.75
      for (let tier = 0; tier < 3; tier++) {
        const top = treeLine + height * (1 - tier * 0.25), branch = (top - direction.y) / (height * 0.48)
        tree ||= branch >= 0 && branch <= 1 && distance < branch * (0.18 + tier * 0.075)
      }
      if (tree) target.copy(palette.trees).multiplyScalar(0.85 + hash(index, 47) * 0.25)
    }
  }
  return target.multiplyScalar(sky.radiance)
}

export function createSkyTexture(preset: Exclude<SkyboxPreset, 'solid'>) {
  const width = 1024, height = 512, pixels = new Uint16Array(width * height * 4)
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
