import * as THREE from 'three'
import { icon } from '../ui/icons'
import type { SkyboxPreset } from './settings'
import './key-light-indicator.css'

/** View-space compass, not a sky object: pan/zoom cannot move an infinite light. */
export function keyLightDirection(camera: THREE.Camera, light: THREE.DirectionalLight) {
  camera.updateWorldMatrix(true, false)
  const direction = light.getWorldPosition(new THREE.Vector3())
    .sub(light.target.getWorldPosition(new THREE.Vector3())).transformDirection(camera.matrixWorldInverse)
  const behind = direction.z > 0
  const extent = Math.max(Math.abs(direction.x), Math.abs(direction.y), behind ? 0 : -direction.z)
  if (extent < 1e-6) return { x: 0, y: -1, behind }
  return { x: direction.x / extent, y: -direction.y / extent, behind }
}

export class KeyLightIndicator {
  readonly element = document.createElement('div')
  private readonly marker: HTMLElement
  private readonly name: HTMLElement
  private readonly facing: HTMLElement

  constructor(host: HTMLElement) {
    this.element.className = 'key-light-guide'
    this.element.hidden = true
    this.element.innerHTML = `<div class="key-light-indicator" role="img">
      <span class="key-light-sun">${icon('render')}</span>
      <span class="key-light-moon">${icon('moon')}</span>
      <span class="key-light-caption"><strong></strong><span></span></span>
    </div>`
    this.marker = this.element.querySelector('.key-light-indicator')!
    this.name = this.element.querySelector('strong')!
    this.facing = this.element.querySelector('.key-light-caption > span')!
    host.append(this.element)
  }

  update(camera: THREE.Camera, light: THREE.DirectionalLight, preset: SkyboxPreset, visible = true) {
    this.element.hidden = !visible
    if (!visible) return
    const { x, y, behind } = keyLightDirection(camera, light)
    const name = preset === 'night' ? 'Moon' : 'Sun'
    const horizontal = x < -0.1 ? 'left' : x > 0.1 ? 'right' : ''
    const vertical = y < -0.1 ? 'above' : y > 0.1 ? 'below' : ''
    this.marker.style.left = `${(x + 1) * 50}%`
    this.marker.style.top = `${(y + 1) * 50}%`
    this.marker.dataset.body = name.toLowerCase()
    this.name.textContent = name
    this.facing.textContent = behind ? 'Behind' : 'Ahead'
    this.marker.setAttribute('aria-label', `${name} key light: ${[vertical, horizontal].filter(Boolean).join(' and ') || 'straight'}, ${behind ? 'behind' : 'ahead of'} the camera.`)
  }

  dispose() { this.element.remove() }
}
