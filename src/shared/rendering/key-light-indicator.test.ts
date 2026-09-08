import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { keyLightDirection, KeyLightIndicator } from './key-light-indicator'

test('key-light compass tracks the actual light in both cameras, without pan/zoom parallax', () => {
  for (const camera of [new THREE.PerspectiveCamera(), new THREE.OrthographicCamera(-20, 20, 20, -20, -1000, 2000)]) {
    const light = new THREE.DirectionalLight()
    light.target.position.set(30, 20, 10)
    for (const [direction, expected] of [
      [[0, 0, -1], { x: 0, y: 0, behind: false }],
      [[1, 1, -1], { x: 1, y: -1, behind: false }],
      [[-1, 1, 1], { x: -1, y: -1, behind: true }],
      [[0, 0, 1], { x: 0, y: -1, behind: true }],
    ] as const) {
      light.position.copy(light.target.position).add(new THREE.Vector3(...direction))
      const before = keyLightDirection(camera, light)
      expect(before.x).toBeCloseTo(expected.x)
      expect(before.y).toBeCloseTo(expected.y)
      expect(before.behind).toBe(expected.behind)
      camera.position.set(100, -50, 25); camera.zoom = 4; camera.updateProjectionMatrix()
      expect(keyLightDirection(camera, light)).toEqual(before)
    }
    camera.rotation.y = Math.PI
    light.position.copy(light.target.position).add(new THREE.Vector3(0, 0, -1))
    expect(keyLightDirection(camera, light).behind).toBe(true)
  }
})

test('indicator labels sun/moon in every preset, including solid, and removes its owned overlay', () => {
  const element = { hidden: true, remove() { this.hidden = true } }
  const marker = { style: {}, dataset: {}, setAttribute(_name: string, value: string) { this.label = value }, label: '' }
  const name = { textContent: '' }, facing = { textContent: '' }
  const indicator = Object.assign(Object.create(KeyLightIndicator.prototype), { element, marker, name, facing })
  const camera = new THREE.PerspectiveCamera(), light = new THREE.DirectionalLight()
  light.position.set(-1, 1, 1)
  for (const preset of ['solid', 'daylight', 'overcast', 'sunset', 'night'] as const) {
    indicator.update(camera, light, preset)
    expect(element.hidden).toBe(false)
    expect(name.textContent).toBe(preset === 'night' ? 'Moon' : 'Sun')
    expect(facing.textContent).toBe('Behind')
    expect(marker.label).toContain('above and left, behind the camera')
    expect(marker.style).toEqual({ left: '0%', top: '0%' })
  }
  indicator.update(camera, light, 'night', false)
  expect(element.hidden).toBe(true)
  indicator.update(camera, light, 'night', true)
  expect(element.hidden).toBe(false)
  indicator.dispose()
  expect(element.hidden).toBe(true)
})
