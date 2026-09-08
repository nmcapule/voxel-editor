import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { skyColor, SKY_LIGHTING } from './sky'

test('procedural sky contains cloud variation, layered terrain and stronger moonlight', () => {
  const sample = (preset: keyof typeof SKY_LIGHTING, azimuth: number, height: number) => skyColor(preset,
    new THREE.Vector3(Math.cos(azimuth) * Math.sqrt(1 - height * height), height, Math.sin(azimuth) * Math.sqrt(1 - height * height)))
  for (const preset of Object.keys(SKY_LIGHTING) as (keyof typeof SKY_LIGHTING)[]) {
    // Opposite the key light: the old gradient/glow was constant across this band.
    const cloudBand = Array.from({ length: 100 }, (_, i) => sample(preset, Math.PI / 2 + i / 99 * Math.PI, 0.4).r)
    expect(Math.max(...cloudBand) - Math.min(...cloudBand)).toBeGreaterThan(0.015)
    const terrain = Array.from({ length: 100 }, (_, i) => sample(preset, i / 100 * Math.PI * 2, 0.11).getHex())
    const trees = Array.from({ length: 300 }, (_, i) => sample(preset, i / 300 * Math.PI * 2, -0.035).getHex())
    expect(new Set(terrain).size).toBeGreaterThan(10)
    expect(new Set(trees).size).toBeGreaterThan(10)
  }
  expect(SKY_LIGHTING.night.keyStrength).toBeGreaterThan(0.3)
  const elevation = THREE.MathUtils.degToRad(SKY_LIGHTING.night.elevation)
  expect(sample('night', 0, Math.sin(elevation)).r).toBeGreaterThan(sample('night', Math.PI, Math.sin(elevation)).r + 1)
})
