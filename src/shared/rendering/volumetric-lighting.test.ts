import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { VolumetricLighting, volumetricRegion, type VolumetricLightingConfig } from './volumetric-lighting'

test('volumetric region is content-scaled, translated, padded and empty-safe without mutating content', () => {
  for (const scale of [0.001, 1, 10000]) {
    const content = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 2, 1).multiplyScalar(scale))
    const before = content.clone(), { bounds, density } = volumetricRegion(content)
    expect(content.equals(before)).toBe(true)
    expect(bounds.min.toArray()).toEqual([-scale, -scale, -scale])
    expect(bounds.max.toArray()).toEqual([5 * scale, 3 * scale, 2 * scale])
    expect(bounds.getCenter(new THREE.Vector3()).distanceTo(content.getCenter(new THREE.Vector3()))).toBeLessThan(1e-10)
    expect(density * bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(0.4, 12)
    const offset = new THREE.Vector3(31, -71, 121).multiplyScalar(scale)
    const moved = volumetricRegion(content.translate(offset))
    expect(moved.density).toBeCloseTo(density, 8)
    expect(moved.bounds.min.distanceTo(bounds.min.add(offset))).toBeLessThan(1e-10)
  }
  const empty = volumetricRegion(new THREE.Box3())
  expect(empty.bounds.isEmpty()).toBe(true)
  expect(empty.density).toBe(0)
  const point = volumetricRegion(new THREE.Box3(new THREE.Vector3(2, 3, 4), new THREE.Vector3(2, 3, 4)))
  expect(point.bounds.getSize(new THREE.Vector3()).toArray()).toEqual([0.5, 0.5, 0.5])
  expect(point.density * 0.5).toBeCloseTo(0.4)
  expect(() => volumetricRegion(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(Infinity, 1, 1)))).toThrow('finite bounds')
})

test('fog density scales optical depth while spread follows content scale without mutation', () => {
  for (const scale of [0.001, 1, 10000]) for (const fogDensity of [0, 1, 3]) for (const fogSpread of [0, 0.25, 1]) {
    const content = new THREE.Box3(new THREE.Vector3(-2, 1, 3).multiplyScalar(scale), new THREE.Vector3(2, 3, 4).multiplyScalar(scale))
    const before = content.clone(), { bounds, density } = volumetricRegion(content, fogDensity, fogSpread)
    const padding = 4 * scale * fogSpread
    expect(bounds.min.toArray()).toEqual(before.min.clone().addScalar(-padding).toArray())
    expect(bounds.max.toArray()).toEqual(before.max.clone().addScalar(padding).toArray())
    expect(density * (4 * scale + 2 * padding)).toBeCloseTo(0.4 * fogDensity, 12)
    if (fogDensity === 0) expect(density).toBe(0)
    expect(content.equals(before)).toBe(true)
    if (fogDensity === 1 && fogSpread === 0.25) expect({ bounds, density }).toEqual(volumetricRegion(content))
  }
})

test('empty and zero-extent fog regions stay finite at density and spread limits', () => {
  const point = new THREE.Box3(new THREE.Vector3(2, 3, 4), new THREE.Vector3(2, 3, 4))
  for (const fogDensity of [0, 1, 3]) for (const fogSpread of [0, 0.25, 1]) {
    const empty = volumetricRegion(new THREE.Box3(), fogDensity, fogSpread)
    expect(empty.bounds.isEmpty()).toBe(true)
    expect(empty.density).toBe(0)
    const { bounds, density } = volumetricRegion(point, fogDensity, fogSpread)
    expect(bounds.getSize(new THREE.Vector3()).toArray()).toEqual([2 * fogSpread, 2 * fogSpread, 2 * fogSpread])
    expect(density).toBe(0.4 * fogDensity / (2 * fogSpread || 1))
    expect([...bounds.min, ...bounds.max, density].every(Number.isFinite)).toBe(true)
  }
})

test('fog controls reject nonfinite and out-of-range values, including for empty content', () => {
  const content = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(4, 2, 1))
  for (const bounds of [content, new THREE.Box3()]) {
    for (const density of [NaN, Infinity, -Infinity, -0.01, 3.01]) expect(() => volumetricRegion(bounds, density)).toThrow('density')
    for (const spread of [NaN, Infinity, -Infinity, -0.01, 1.01]) expect(() => volumetricRegion(bounds, 1, spread)).toThrow('spread')
  }
  for (const end of ['min', 'max'] as const) for (const axis of ['x', 'y', 'z'] as const) {
    for (const value of [NaN, end === 'min' ? -Infinity : Infinity]) {
      const bounds = content.clone()
      bounds[end][axis] = value
      expect(() => volumetricRegion(bounds)).toThrow('finite bounds')
    }
  }
})

test('fog tint updates every render in the same uniform, defaults to white and leaves extinction neutral', () => {
  const effect = new VolumetricLighting(), camera = new THREE.OrthographicCamera(), depth = new THREE.DepthTexture(1, 1)
  const material = Reflect.get(effect, 'scattering') as THREE.ShaderMaterial
  const tint = material.uniforms.fogColor.value as THREE.Color
  const config: VolumetricLightingConfig = {
    ...volumetricRegion(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(4, 2, 1))),
    light: new THREE.DirectionalLight(), ambient: new THREE.Color(0.2, 0.3, 0.4),
  }
  const renderer = { shadowMap: { enabled: false }, setRenderTarget() {}, render() {} } as unknown as THREE.WebGLRenderer
  try {
    expect(tint.toArray()).toEqual([1, 1, 1])
    effect.render(renderer, camera, depth, config)
    expect(tint.toArray()).toEqual([1, 1, 1])
    const version = material.version
    config.color = new THREE.Color('#80a0c0')
    effect.render(renderer, camera, depth, config)
    expect(tint.equals(config.color)).toBe(true)
    expect(tint).not.toBe(config.color)
    config.color.setRGB(0.1, 0.5, 0.9)
    effect.render(renderer, camera, depth, config)
    expect(tint.toArray()).toEqual([0.1, 0.5, 0.9])
    delete config.color
    effect.render(renderer, camera, depth, config)
    expect(tint.toArray()).toEqual([1, 1, 1])
    expect(material.uniforms.fogColor.value).toBe(tint)
    expect(material.uniforms.density.value).toBe(config.density)
    expect(material.version).toBe(version)
    expect(material.fragmentShader).toContain('* incoming * fogColor;')
    expect(material.fragmentShader).toContain('float stepTransmittance = exp(-density * stepLength);')
    expect(material.fragmentShader).toContain('float sunTransmittance = exp(-density * (sunHit ? sunExit : 0.0));')
  } finally {
    effect.dispose(); depth.dispose()
  }
})
