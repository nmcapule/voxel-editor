import { expect, spyOn, test } from 'bun:test'
import * as THREE from 'three'
// @ts-expect-error The pinned tracer exports this material but omits it from its declarations.
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer/src/index.js'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import { RasterPipeline } from './raster-pipeline'
import { installSkyBackground, SKY_BACKGROUND_FOV, SkyBackground } from './sky-background'

test('panorama shares an 80 degree perspective backdrop without altering orthographic model rays', () => {
  const sky = new SkyBackground(), scene = new THREE.Scene(), ray = new THREE.Raycaster()
  const camera = new THREE.OrthographicCamera(-20, 20, 10, -10, -1000, 2000)
  camera.position.set(14, 8, 20)
  camera.lookAt(2, 1, 0)
  scene.backgroundRotation.set(0.1, -Math.PI / 2, 0.2)
  const perspective = new THREE.PerspectiveCamera(SKY_BACKGROUND_FOV, 2)
  perspective.quaternion.copy(camera.quaternion)
  perspective.updateMatrixWorld()
  const tangent = Number(sky.fragmentShader.match(/vec2\(aspect, 1.0\) \* ([\d.]+)/)![1])
  const sample = (x: number, y: number) => new THREE.Vector3(x * sky.uniforms.aspect.value * tangent, y * tangent, -1)
    .transformDirection(sky.uniforms.cameraWorld.value).transformDirection(sky.uniforms.skyRotation.value)
  try {
    let baseline: THREE.Vector3[] | undefined
    for (const zoom of [0.2, 1, 20]) {
      camera.zoom = zoom
      camera.position.addScalar(100) // Pan and zoom must not move the panorama.
      camera.updateProjectionMatrix(); camera.updateMatrixWorld()
      const before = camera.toJSON()
      sky.update(camera, scene)
      expect(camera.toJSON()).toEqual(before)
      const samples: THREE.Vector3[] = [], modelDirections: THREE.Vector3[] = []
      for (const [x, y] of [[-1, -1], [1, 1], [0, 0]]) {
        const ndc = new THREE.Vector2(x, y)
        ray.setFromCamera(ndc, camera)
        modelDirections.push(ray.ray.direction.clone())
        ray.setFromCamera(ndc, perspective)
        const expected = ray.ray.direction.clone().transformDirection(sky.uniforms.skyRotation.value)
        samples.push(sample(x, y))
        expect(samples.at(-1)!.distanceTo(expected)).toBeLessThan(1e-12)
      }
      expect(modelDirections[0].equals(modelDirections[1])).toBe(true)
      expect(samples[0].distanceTo(samples[1])).toBeGreaterThan(1)
      if (baseline) for (let i = 0; i < samples.length; i++) expect(samples[i].distanceTo(baseline[i])).toBeLessThan(1e-12)
      baseline = samples
    }
    const direction = sample(0.6, 0.4)
    scene.backgroundRotation.y += Math.PI / 2
    sky.update(camera, scene)
    expect(sample(0.6, 0.4).distanceTo(direction)).toBeGreaterThan(0.5)
    camera.rotateY(0.8); camera.updateMatrixWorld(); sky.update(camera, scene)
    expect(sample(0.6, 0.4).distanceTo(direction)).toBeGreaterThan(0.5)
  } finally { sky.dispose() }
})

test('pinned tracer patch changes only background misses, preserves native jitter/rays/lighting and rejects drift atomically', () => {
  const material = new PhysicalPathTracingMaterial(), untouched = new PhysicalPathTracingMaterial(), sky = new SkyBackground()
  const tracer = { _pathTracer: { material } } as unknown as WebGLPathTracer
  const original = material.fragmentShader as string
  try {
    const enabled = installSkyBackground(tracer, true)
    expect(material.uniforms.panoramaEnabled).toBe(enabled)
    expect(untouched.fragmentShader).toBe(original)
    const patched = material.fragmentShader as string
    const cameraCode = (shader: string) => shader.slice(shader.indexOf('Ray getCameraRay() {'), shader.indexOf('return ray;'))
    expect(cameraCode(patched).replace('panoramaUv = jitteredUv;\n\t\t', '')).toBe(cameraCode(original))
    const main = (shader: string) => shader.slice(shader.lastIndexOf('void main() {'))
    expect(main(patched).replace('\n\t\tvec3 panoramaPrimaryDirection = ray.direction;', '')
      .replace('panoramaMissDirection(ray.direction, panoramaPrimaryDirection)', 'ray.direction')).toBe(main(original))
    expect(patched).toContain('#if CAMERA_TYPE == 1 && FEATURE_BACKGROUND_MAP')
    expect(patched).toContain('if (panoramaEnabled)')
    expect(patched).toContain('if ( state.firstRay || state.transmissiveRay )')
    const directionCode = (shader: string) => shader.match(/vec3 panoramaDirection\([\s\S]*?\n  }/)![0]
    expect(directionCode(patched)).toBe(directionCode(sky.fragmentShader))
    const version = material.version
    enabled.value = false
    expect(material.version).toBe(version)
    expect(material.fragmentShader).toBe(patched)
    expect(() => installSkyBackground(tracer, true)).toThrow('already patched')
    for (const marker of ['Ray getCameraRay() {', 'Ray ray;', 'Ray ray = getCameraRay();', 'sampleBackground( ray.direction, rand2( 2 ) )']) {
      const broken = new THREE.ShaderMaterial({ fragmentShader: original.replace(marker, 'unsupported'), uniforms: material.uniforms })
      const before = broken.fragmentShader
      expect(() => installSkyBackground({ _pathTracer: { material: broken } } as unknown as WebGLPathTracer, true)).toThrow('shader marker')
      expect(broken.fragmentShader).toBe(before)
      broken.dispose()
    }
    expect(() => installSkyBackground({} as WebGLPathTracer, true)).toThrow('physical material')
  } finally { material.dispose(); untouched.dispose(); sky.dispose() }
})

test('transmissive background rotation retains refraction angle without bending the traced ray', () => {
  const primary = new THREE.Vector3(0, 0, -1), miss = new THREE.Vector3(0.1, -0.2, -1).normalize()
  const saved = miss.clone(), tangent = Math.tan(THREE.MathUtils.degToRad(SKY_BACKGROUND_FOV / 2))
  for (const [x, y] of [[0, 0], [-1, 1], [1, -1]]) {
    const virtual = new THREE.Vector3(x * 2 * tangent, y * tangent, -1).normalize()
    const axis = primary.clone().cross(virtual)
    const rotated = miss.clone().add(axis.clone().cross(miss))
      .add(axis.clone().cross(axis.clone().cross(miss)).divideScalar(1 + primary.dot(virtual)))
    const expected = miss.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(primary, virtual))
    expect(rotated.distanceTo(expected)).toBeLessThan(1e-12)
    expect(rotated.dot(virtual)).toBeCloseTo(miss.dot(primary), 12)
    expect(miss.equals(saved)).toBe(true)
  }
})

test('raster draws panorama before opaque/transmission, restores failures and lazily owns only its material', () => {
  const scene = new THREE.Scene(), sky = new THREE.Texture()
  sky.mapping = THREE.EquirectangularReflectionMapping
  const glass = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ transmission: 1 }))
  scene.add(glass)
  let target: THREE.WebGLRenderTarget | null = null, fail = false, occupancy = 0
  const draws: { material?: THREE.ShaderMaterial; target: THREE.WebGLRenderTarget | null; background?: THREE.Scene['background'] }[] = []
  const renderer = {
    capabilities: { maxTextureSize: 4096 }, autoClear: true, shadowMap: { enabled: false, autoUpdate: false, needsUpdate: false },
    xr: { enabled: false }, clippingPlanes: [], toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace, state: { buffers: { depth: { setClear() {} } } },
    getContext: () => ({ isContextLost: () => false, getParameter: () => 1 }),
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(8, 4), getRenderTarget: () => target,
    getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, getScissorTest: () => false,
    getViewport: (v: THREE.Vector4) => v.set(0, 0, 8, 4), getScissor: (v: THREE.Vector4) => v.set(0, 0, 8, 4),
    getClearColor: (v: THREE.Color) => v.set(0), getClearAlpha: () => 1,
    setRenderTarget: (value: THREE.WebGLRenderTarget | null) => { target = value },
    setViewport() {}, setScissor() {}, setScissorTest() {}, setClearColor() {}, clear() {},
    render(object: THREE.Object3D) {
      const material = (object as THREE.Mesh).material as THREE.ShaderMaterial | undefined
      draws.push({ material, target, background: object === scene ? scene.background : undefined })
      if (material?.name === 'SkyBackground') expect(material.uniforms.skyMap.value).toBe(sky)
      if (fail && object === scene) throw new Error('opaque failed')
    },
    readRenderTargetPixels(_target: unknown, _x: number, _y: number, _w: number, _h: number, pixels: Uint8Array) {
      pixels[0] = occupancy-- > 0 ? 255 : 0
    },
  } as unknown as THREE.WebGLRenderer
  const pipeline = new RasterPipeline(renderer, scene, { ambientOcclusion: false, antialias: false })
  pipeline.renderToScreen = false
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1)
  const borrowed = spyOn(sky, 'dispose')
  try {
    for (const background of [null, new THREE.Color('#abcdef'), sky]) {
      scene.background = background
      pipeline.render(background === sky ? new THREE.PerspectiveCamera() : camera)
      expect(Reflect.get(pipeline, 'skyBackground')).toBeUndefined()
    }
    draws.length = 0
    occupancy = 1
    scene.backgroundIntensity = 1.7
    const before = camera.toJSON()
    pipeline.render(camera)
    const material = draws[0].material!
    expect(material).toBeInstanceOf(SkyBackground)
    expect(material.uniforms.intensity.value).toBe(1.7)
    expect(draws[1].background).toBeNull()
    expect(draws[0].target).toBe(draws[1].target)
    expect(pipeline.lastFrame.layers).toBe(1)
    expect(material).toMatchObject({ depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending })
    expect(material.uniforms.skyMap.value).toBeNull()
    expect(scene.background).toBe(sky)
    expect(camera.toJSON()).toEqual(before)
    expect(target).toBeNull()
    const dispose = spyOn(material, 'dispose')
    pipeline.setSize(20, 10)
    expect(dispose).not.toHaveBeenCalled()
    fail = true
    expect(() => pipeline.render(camera)).toThrow('opaque failed')
    expect(scene.background).toBe(sky)
    expect(material.uniforms.skyMap.value).toBeNull()
    expect(pipeline.lastFrame.complete).toBe(false)
    expect(target).toBeNull()
    fail = false
    scene.background = new THREE.Color('#abcdef')
    draws.length = 0
    pipeline.render(camera)
    expect(draws.some(draw => draw.material === material)).toBe(false)
    expect(draws[0].background).toBe(scene.background)
    pipeline.dispose(); pipeline.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(borrowed).not.toHaveBeenCalled()
  } finally { pipeline.dispose(); borrowed.mockRestore(); sky.dispose(); glass.geometry.dispose(); glass.material.dispose() }
})
