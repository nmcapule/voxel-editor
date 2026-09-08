import { expect, mock, test } from 'bun:test'
import * as THREE from 'three'
import { DEFAULT_SETTINGS } from './settings'
import { TiltShift } from './tilt-shift'

// Exercise the real copy/quad driver, not shader compilation or pixel correctness.
function rendererProbe() {
  const initialTarget = new THREE.WebGLRenderTarget(7, 9)
  const state = {
    target: initialTarget as THREE.WebGLRenderTarget | null,
    viewport: new THREE.Vector4(2, 3, 7, 9), scissor: new THREE.Vector4(1, 2, 5, 6), scissorTest: true,
    failAt: '' as '' | 'copy' | 'output',
  }
  const calls: string[] = [], copies: THREE.FramebufferTexture[] = []
  const draws: {
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; target: THREE.WebGLRenderTarget | null;
    image: THREE.Texture; axis: number[]; focus: number; halfWidth: number; viewport: number[];
  }[] = []
  const renderer = {
    domElement: { width: 160, height: 80 }, autoClear: true,
    outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.08,
    getPixelRatio: () => 2,
    getRenderTarget: () => state.target,
    getViewport: (value: THREE.Vector4) => value.copy(state.viewport),
    getScissor: (value: THREE.Vector4) => value.copy(state.scissor),
    getScissorTest: () => state.scissorTest,
    setRenderTarget(target: THREE.WebGLRenderTarget | null) { state.target = target },
    setViewport(x: THREE.Vector4 | number, y?: number, width?: number, height?: number) {
      if (typeof x === 'number') state.viewport.set(x, y!, width!, height!)
      else state.viewport.copy(x)
    },
    setScissor: mock((value: THREE.Vector4) => state.scissor.copy(value)),
    setScissorTest(value: boolean) { state.scissorTest = value },
    copyFramebufferToTexture(texture: THREE.FramebufferTexture) {
      calls.push('copy'); copies.push(texture)
      expect(state.target).toBeNull()
      expect(state.scissorTest || renderer.autoClear).toBe(false)
      if (state.failAt === 'copy') throw new Error('copy failed')
    },
    render(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>) {
      calls.push('quad')
      expect(state.scissorTest || renderer.autoClear).toBe(false)
      const uniforms = mesh.material.uniforms
      draws.push({ mesh, target: state.target, image: uniforms.image.value, axis: uniforms.axis.value.toArray(),
        focus: uniforms.focus.value, halfWidth: uniforms.halfWidth.value, viewport: state.viewport.toArray() })
      if (state.failAt === 'output' && state.target === null) throw new Error('output failed')
    },
  }
  return { state, renderer, webgl: renderer as unknown as THREE.WebGLRenderer, calls, copies, draws, initialTarget }
}

test('tilt shift copies once before two quad passes without applying output conversion again', () => {
  const h = rendererProbe(), effect = new TiltShift()
  try {
    effect.render(h.webgl, { ...DEFAULT_SETTINGS, tiltShiftStrength: 0.8, tiltShiftFocus: 0.2, tiltShiftWidth: 0.4 })
    expect(h.calls).toEqual(['copy', 'quad', 'quad'])
    const [horizontal, vertical] = h.draws, source = h.copies[0], scratch = horizontal.target!
    expect(source.image).toMatchObject({ width: 160, height: 80 })
    expect(source.minFilter).toBe(THREE.LinearFilter)
    expect(source.magFilter).toBe(THREE.LinearFilter)
    expect(scratch).toMatchObject({ width: 160, height: 80, depthBuffer: false })
    expect(horizontal.image).toBe(source)
    expect(vertical.image).toBe(scratch.texture)
    expect(vertical.target).toBeNull()
    expect(vertical.mesh).toBe(horizontal.mesh)
    expect(horizontal.axis[0]).toBeCloseTo(0.0012, 8)
    expect(horizontal.axis[1]).toBe(0)
    expect(vertical.axis[0]).toBe(0)
    expect(vertical.axis[1]).toBeCloseTo(0.0024, 8)
    expect(horizontal.focus).toBe(0.8)
    expect(horizontal.halfWidth).toBe(0.2)
    expect(vertical.viewport).toEqual([0, 0, 80, 40])
    const material = horizontal.mesh.material
    expect(material).toMatchObject({ toneMapped: false, depthTest: false, depthWrite: false, blending: THREE.NoBlending })
    expect(material.fragmentShader).not.toMatch(/tonemapping_fragment|colorspace_fragment|linearToOutputTexel/)
    expect(source.colorSpace).toBe(THREE.NoColorSpace)
    expect(scratch.texture.colorSpace).toBe(THREE.NoColorSpace)
    expect(h.renderer).toMatchObject({ outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.08, autoClear: true })
    expect(h.state.target).toBe(h.initialTarget)
    expect(h.state.viewport.toArray()).toEqual([2, 3, 7, 9])
    expect(h.state.scissor.toArray()).toEqual([1, 2, 5, 6])
    expect(h.renderer.setScissor).toHaveBeenLastCalledWith(new THREE.Vector4(1, 2, 5, 6))
    expect(h.state.scissorTest).toBe(true)
  } finally { effect.dispose(); h.initialTarget.dispose() }
})

test('tilt shift restores renderer state after copy or output failure and can be retried', () => {
  const h = rendererProbe(), effect = new TiltShift()
  try {
    for (const failure of ['copy', 'output'] as const) {
      h.state.failAt = failure
      h.renderer.setScissor.mockClear()
      h.renderer.autoClear = failure === 'copy'
      expect(() => effect.render(h.webgl, DEFAULT_SETTINGS)).toThrow(`${failure} failed`)
      expect(h.state.target).toBe(h.initialTarget)
      expect(h.state.viewport.toArray()).toEqual([2, 3, 7, 9])
      expect(h.state.scissor.toArray()).toEqual([1, 2, 5, 6])
      expect(h.renderer.setScissor).toHaveBeenLastCalledWith(new THREE.Vector4(1, 2, 5, 6))
      expect(h.state.scissorTest).toBe(true)
      expect(h.renderer.autoClear).toBe(failure === 'copy')
    }
    h.state.failAt = ''
    h.calls.length = 0
    effect.render(h.webgl, DEFAULT_SETTINGS)
    expect(h.calls).toEqual(['copy', 'quad', 'quad'])
  } finally { effect.dispose(); h.initialTarget.dispose() }
})

test('tilt shift reuses same-size resources, resizes to the drawing buffer and disposes owned resources', () => {
  const h = rendererProbe(), effect = new TiltShift()
  effect.render(h.webgl, DEFAULT_SETTINGS)
  const source = h.copies[0], scratch = h.draws[0].target!, mesh = h.draws[0].mesh
  const disposed = { source: 0, replacement: 0, scratch: 0, material: 0, quad: 0 }
  source.addEventListener('dispose', () => { disposed.source++ })
  scratch.addEventListener('dispose', () => { disposed.scratch++ })
  mesh.material.addEventListener('dispose', () => { disposed.material++ })
  const quadDisposed = () => { disposed.quad++ }
  mesh.geometry.addEventListener('dispose', quadDisposed)
  try {
    effect.render(h.webgl, DEFAULT_SETTINGS)
    expect(h.copies[1]).toBe(source)
    expect(h.draws[2].target).toBe(scratch)
    expect(disposed).toEqual({ source: 0, replacement: 0, scratch: 0, material: 0, quad: 0 })
    h.renderer.domElement.width = 80
    h.renderer.domElement.height = 160
    effect.render(h.webgl, DEFAULT_SETTINGS)
    const replacement = h.copies[2]
    replacement.addEventListener('dispose', () => { disposed.replacement++ })
    expect(replacement).not.toBe(source)
    expect(replacement.image).toMatchObject({ width: 80, height: 160 })
    expect(h.draws[4].target).toBe(scratch)
    expect(scratch).toMatchObject({ width: 80, height: 160 })
    expect(h.draws[4].axis).toEqual([0.003, 0])
    expect(h.draws[5].viewport).toEqual([0, 0, 40, 80])
    expect(disposed).toEqual({ source: 1, replacement: 0, scratch: 1, material: 0, quad: 0 })
  } finally {
    effect.dispose(); h.initialTarget.dispose()
    mesh.geometry.removeEventListener('dispose', quadDisposed)
  }
  expect(disposed).toEqual({ source: 1, replacement: 1, scratch: 2, material: 1, quad: 1 })
})
