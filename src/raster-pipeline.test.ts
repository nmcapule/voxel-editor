import { expect, spyOn, test } from 'bun:test'
import * as THREE from 'three'
import { RasterPipeline, transparentTriangleBound } from './raster-pipeline'

// A render-state double, not a rasterizer. Pixel ordering, shader compilation and AA
// still require the parent's WebGL browser audit; these checks exercise the real driver loop.
function harness(scene: THREE.Scene, occupancy: number[] = [0]) {
  const initialTarget = new THREE.WebGLRenderTarget(7, 9)
  const state = {
    target: initialTarget as THREE.WebGLRenderTarget | null,
    viewport: new THREE.Vector4(2, 3, 7, 9), scissor: new THREE.Vector4(1, 2, 5, 6), scissorTest: true,
    clearColor: new THREE.Color(0x123456), clearAlpha: 0.7, clearDepth: 0.9,
    face: 2, mip: 1, lost: false, reads: 0,
  }
  const draws: { object: THREE.Object3D; target: THREE.WebGLRenderTarget | null }[] = []
  let onScene: () => void = () => {}
  let onRead: () => void = () => {}
  const renderer = {
    capabilities: { maxTextureSize: 8192, logarithmicDepthBuffer: false, reversedDepthBuffer: false },
    autoClear: true, shadowMap: { autoUpdate: true, needsUpdate: true }, xr: { enabled: true },
    toneMapping: THREE.ReinhardToneMapping, toneMappingExposure: 1.08, outputColorSpace: THREE.LinearSRGBColorSpace,
    state: { buffers: { depth: { setClear(value: number) { state.clearDepth = value } } } },
    getContext: () => ({ DEPTH_CLEAR_VALUE: 0x0b73, getParameter: () => state.clearDepth, isContextLost: () => state.lost }),
    getDrawingBufferSize: (value: THREE.Vector2) => value.set(3, 5),
    getSize: (value: THREE.Vector2) => value.set(3, 5),
    getRenderTarget: () => state.target,
    getActiveCubeFace: () => state.face,
    getActiveMipmapLevel: () => state.mip,
    getViewport: (value: THREE.Vector4) => value.copy(state.viewport),
    getScissor: (value: THREE.Vector4) => value.copy(state.scissor),
    getScissorTest: () => state.scissorTest,
    getClearColor: (value: THREE.Color) => value.copy(state.clearColor),
    getClearAlpha: () => state.clearAlpha,
    setRenderTarget(target: THREE.WebGLRenderTarget | null, face = 0, mip = 0) { Object.assign(state, { target, face, mip }) },
    setViewport(x: THREE.Vector4 | number, y?: number, width?: number, height?: number) {
      if (typeof x === 'number') state.viewport.set(x, y!, width!, height!)
      else state.viewport.copy(x)
    },
    setScissor: (value: THREE.Vector4) => state.scissor.copy(value),
    setScissorTest: (value: boolean) => { state.scissorTest = value },
    setClearColor(value: THREE.ColorRepresentation, alpha = 1) { state.clearColor.set(value); state.clearAlpha = alpha },
    setClearAlpha: (value: number) => { state.clearAlpha = value },
    clear() {},
    render(object: THREE.Object3D) {
      draws.push({ object, target: state.target })
      if (object === scene) onScene()
    },
    readRenderTargetPixels(target: THREE.WebGLRenderTarget, _x: number, _y: number, width: number, height: number, pixels: Uint8Array) {
      expect([target.width, target.height, width, height]).toEqual([1, 1, 1, 1])
      state.reads++
      pixels.set([occupancy.shift() ?? 0, 0, 0, 255])
      onRead()
    },
  }
  const webgl = renderer as unknown as THREE.WebGLRenderer
  const pipeline = new RasterPipeline(webgl, scene, { ambientOcclusion: false, maxFrameMilliseconds: 60_000 })
  pipeline.renderToScreen = false
  return {
    pipeline, renderer, webgl, state, draws, initialTarget,
    onScene(callback: () => void) { onScene = callback },
    onRead(callback: () => void) { onRead = callback },
  }
}

function triangles(count: number) {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(count * 9)
  for (let index = 2; index < positions.length; index += 3) positions[index] = -1
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

test('layer bound honors indices, material-local groups, draw range, visibility and instances', () => {
  const opaque = new THREE.MeshPhysicalMaterial()
  const glass = new THREE.MeshPhysicalMaterial({ transmission: 1 })
  const alpha = new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.4 })
  const geometry = triangles(100)
  geometry.setIndex(Array.from({ length: 36 }, (_, index) => index))
  geometry.addGroup(0, 12, 0)
  geometry.addGroup(12, 12, 1)
  geometry.addGroup(24, 12, 2)
  geometry.setDrawRange(6, 24)
  const mesh = new THREE.InstancedMesh(geometry, [opaque, glass, alpha], 7)
  expect(transparentTriangleBound(mesh)).toBe(42)
  alpha.visible = false
  expect(transparentTriangleBound(mesh)).toBe(28)
  mesh.count = 0
  expect(transparentTriangleBound(mesh)).toBe(0)
  const single = new THREE.Mesh(geometry, glass)
  expect(transparentTriangleBound(single)).toBe(8)
  geometry.setDrawRange(40, 3)
  expect(transparentTriangleBound(single)).toBe(0)
})

test('terminates on the first empty peel, not an arbitrary fixed layer cap', () => {
  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(triangles(300), new THREE.MeshPhysicalMaterial({ transmission: 1 })))
  const h = harness(scene, [...Array<number>(257).fill(255), 0])
  h.pipeline.render(new THREE.OrthographicCamera())
  expect(h.pipeline.lastFrame).toEqual({ layers: 257, triangleBound: 300, complete: true })
  expect(h.state.reads).toBe(258)
  expect(h.draws.at(-1)?.target).toBe(h.pipeline.readBuffer)
  h.pipeline.dispose()
})

test('nonconvergence, invalid readback and context loss fail without publishing a partial frame', () => {
  for (const failure of ['bound', 'readback', 'context'] as const) {
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(triangles(1), new THREE.MeshPhysicalMaterial({ transmission: 1 }))
    scene.add(mesh)
    const original = mesh.material
    const h = harness(scene, failure === 'readback' ? [127] : [255, 255])
    if (failure === 'context') h.onRead(() => { h.state.lost = true })
    expect(() => h.pipeline.render(new THREE.PerspectiveCamera())).toThrow(
      failure === 'bound' ? 'geometry-derived bound' : failure === 'readback' ? 'readback failed' : 'context lost',
    )
    expect(h.pipeline.lastFrame.complete).toBe(false)
    expect(h.draws.some(draw => draw.target === h.pipeline.readBuffer)).toBe(false)
    expect(mesh.material).toBe(original)
    expect(h.state.target).toBe(h.initialTarget)
    expect(h.renderer.shadowMap.needsUpdate).toBe(true)
    h.pipeline.dispose()
  }
})

test('physical variants retain maps, opacity, IOR and dynamic transmission uniforms without scheduling a Three prepass', () => {
  const scene = new THREE.Scene()
  const transmissionMap = new THREE.Texture()
  transmissionMap.channel = 2
  transmissionMap.offset.set(0.2, 0.3)
  const source = new THREE.MeshPhysicalMaterial({
    transmission: 0.75, opacity: 0.45, ior: 1.333, thickness: 1.2, attenuationDistance: 4,
    roughness: 0.32, metalness: 0.2, envMapIntensity: 0.7, vertexColors: true,
    map: new THREE.Texture(), normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture(),
    metalnessMap: new THREE.Texture(), envMap: new THREE.Texture(), transmissionMap,
    thicknessMap: new THREE.Texture(), transparent: true, depthWrite: false,
  })
  source.onBeforeCompile = shader => { shader.uniforms.customSourceUniform = { value: 42 } }
  const originalCallback = source.onBeforeCompile
  const mesh = new THREE.Mesh(triangles(2), source)
  scene.add(mesh)
  const h = harness(scene, [255, 0, 255, 0, 255, 0])
  const shaders: THREE.WebGLProgramParametersWithUniforms[] = []
  const versions = new Map<THREE.Material, number>()
  h.onScene(() => {
    const material = mesh.material
    if (!material.visible) return
    versions.set(material, material.version)
    expect(material).not.toBe(source)
    expect(material.transmission).toBe(0)
    expect(material.defines?.USE_TRANSMISSION).toBe('')
    expect(material.defines?.USE_TRANSMISSIONMAP).toBe('')
    expect(material.defines?.TRANSMISSIONMAP_UV).toBe('uv2')
    expect(material.defines?.USE_UV2).toBe('')
    for (const property of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'envMap', 'roughness', 'opacity', 'ior', 'envMapIntensity'] as const) {
      expect(material[property]).toBe(source[property])
    }
    const shader = {
      vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms),
    } as THREE.WebGLProgramParametersWithUniforms
    material.onBeforeCompile(shader, h.webgl)
    expect(shader.vertexShader).toContain('invariant gl_Position;')
    expect(shader.fragmentShader).not.toContain('transmissionSamplerMap')
    expect(shader.fragmentShader).toContain('rasterTransmissionMap')
    expect(shader.uniforms.transmission.value).toBe(source.transmission)
    expect(shader.uniforms.thickness.value).toBe(1.2)
    expect(shader.uniforms.attenuationDistance.value).toBe(4)
    expect(shader.uniforms.transmissionMapTransform.value).toBe(transmissionMap.matrix)
    expect(shader.uniforms.customSourceUniform.value).toBe(42)
    if (material.depthFunc === THREE.GreaterEqualDepth) {
      expect(material.blending).toBe(THREE.NoBlending)
      expect(shader.fragmentShader).toContain('gl_FragDepth = gl_FragCoord.z;')
    } else {
      expect(shader.fragmentShader).toContain('gl_FragCoord.z != texelFetch(rasterSelectedDepth')
      expect(material.depthWrite).toBe(false)
      shaders.push(shader)
    }
  })
  h.pipeline.render(new THREE.PerspectiveCamera())
  const copy = spyOn(THREE.MeshPhysicalMaterial.prototype, 'copy')
  h.onScene(() => {
    const material = mesh.material
    if (!material.visible) return
    expect(material.version).toBe(versions.get(material)!)
  })
  try {
    transmissionMap.offset.x = 0.8
    h.pipeline.render(new THREE.PerspectiveCamera())
    expect(copy).not.toHaveBeenCalled()
    expect(shaders[0].uniforms.transmissionMapTransform.value.elements[6]).toBe(0.8)
    source.transmission = 0.35
    source.roughness = 0.6
    source.envMapIntensity = 0.9
    source.color.setHex(0x123456)
    source.needsUpdate = true
    h.onScene(() => {
      const material = mesh.material
      if (!material.visible) return
      expect(material.version).toBeGreaterThan(versions.get(material)!)
      expect(material.roughness).toBe(0.6)
      expect(material.envMapIntensity).toBe(0.9)
      expect(material.color.getHex()).toBe(0x123456)
    })
    h.pipeline.render(new THREE.OrthographicCamera())
    expect(copy).toHaveBeenCalledTimes(2)
  } finally {
    copy.mockRestore()
  }
  expect(shaders[0].uniforms.transmission.value).toBe(0.35)
  expect(mesh.material).toBe(source)
  expect(source.onBeforeCompile).toBe(originalCallback)
  expect(source.transmission).toBe(0.35)
  expect(source.defines?.USE_TRANSMISSION).toBeUndefined()
  h.pipeline.dispose()
})

test('AO uses only opaque depth, helpers render last, and successful offscreen inspection restores state', () => {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xabcdef)
  scene.overrideMaterial = new THREE.MeshNormalMaterial()
  const savedBackground = scene.background
  const savedOverride = scene.overrideMaterial
  const opaque = new THREE.Mesh(triangles(1), new THREE.MeshPhysicalMaterial())
  const glass = new THREE.Mesh(triangles(2), new THREE.MeshPhysicalMaterial({ transmission: 1 }))
  const helperGroup = new THREE.Group()
  helperGroup.userData.editorOverlay = true
  const helper = new THREE.Mesh(triangles(1), new THREE.MeshBasicMaterial({ transparent: true }))
  helperGroup.add(helper)
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
  const invisible = new THREE.Mesh(triangles(1), glass.material)
  invisible.visible = false
  // A helper child of a glass parent must not be hidden with its parent's material.
  glass.add(lines)
  scene.add(opaque, glass, helperGroup, invisible)
  const originals = [opaque.material, glass.material, helper.material, lines.material] as const
  const h = harness(scene, [255, 0])
  const camera = new THREE.OrthographicCamera()
  const cameraBefore = camera.toJSON()
  const phases: string[] = []
  h.onScene(() => {
    expect(invisible.visible).toBe(false)
    expect(glass.visible).toBe(true)
    if (opaque.material.visible) {
      phases.push('opaque')
      expect(glass.material.visible || helper.material.visible || lines.material.visible).toBe(false)
    } else if (glass.material.visible) {
      phases.push(glass.material.depthFunc === THREE.GreaterEqualDepth ? 'peel' : 'shade')
      expect(helper.material.visible || lines.material.visible).toBe(false)
      expect(h.renderer.shadowMap.autoUpdate || h.renderer.shadowMap.needsUpdate).toBe(false)
    } else {
      phases.push('overlay')
      expect(helper.material).toBe(originals[2])
      expect(lines.material).toBe(originals[3])
    }
  })
  const ao = h.pipeline.ambientOcclusion
  ao.enabled = true
  expect((ao as unknown as { _renderGBuffer: boolean })._renderGBuffer).toBe(false)
  expect(ao.normalTexture).toBeUndefined()
  expect([ao.width, ao.height]).toEqual([2, 3])
  h.pipeline.render(camera)
  expect(phases).toEqual(['opaque', 'peel', 'shade', 'peel', 'overlay'])
  expect([opaque.material, glass.material, helper.material, lines.material]).toEqual([...originals])
  expect(scene.background).toBe(savedBackground)
  expect(scene.overrideMaterial).toBe(savedOverride)
  expect(camera.toJSON()).toEqual(cameraBefore)
  expect(h.state.target).toBe(h.initialTarget)
  expect(h.state.viewport.toArray()).toEqual([2, 3, 7, 9])
  expect(h.state.scissor.toArray()).toEqual([1, 2, 5, 6])
  expect([h.state.face, h.state.mip, h.state.scissorTest, h.state.clearDepth, h.state.clearAlpha]).toEqual([2, 1, true, 0.9, 0.7])
  expect(h.state.clearColor.getHex()).toBe(0x123456)
  expect(h.renderer.autoClear && h.renderer.xr.enabled && h.renderer.shadowMap.autoUpdate).toBe(true)
  expect(h.renderer.shadowMap.needsUpdate).toBe(false)
  expect(h.renderer.toneMapping).toBe(THREE.ReinhardToneMapping)
  expect(h.renderer.outputColorSpace).toBe(THREE.LinearSRGBColorSpace)
  expect(ao.gtaoMaterial.defines.PERSPECTIVE_CAMERA).toBe(0)
  const targets = h.draws.map(draw => draw.target).filter(target => target !== null)
  expect(targets.some(target => target.depthTexture?.type === THREE.FloatType)).toBe(true)
  const snapshot = targets.find(target => target.texture.generateMipmaps)
  expect(snapshot?.texture.type).toBe(THREE.HalfFloatType)
  expect(snapshot?.depthBuffer).toBe(false)
  expect(snapshot && [snapshot.width, snapshot.height]).toEqual([3, 5])
  const aa = (h.draws.at(-2)?.object as THREE.Mesh).material as THREE.ShaderMaterial
  expect(aa.fragmentShader).toContain('ACESFilmicToneMapping(Sample(tex2D, uv).rgb)')
  expect(aa.fragmentShader).toContain('gl_FragColor = ApplyFXAA(')
  expect(aa.uniforms.resolution.value.toArray()).toEqual([1 / 3, 1 / 5])
  h.pipeline.dispose()
})

test('exceptions restore mixed material arrays and allow a retry; opaque scenes never peel', () => {
  const scene = new THREE.Scene()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshPhysicalMaterial(), new THREE.MeshPhysicalMaterial({ transmission: 1 })])
  const original = mesh.material
  scene.add(mesh)
  const h = harness(scene)
  h.onScene(() => { throw new Error('injected draw failure') })
  expect(() => h.pipeline.render(new THREE.PerspectiveCamera())).toThrow('injected draw failure')
  expect(mesh.material).toBe(original)
  expect(h.state.target).toBe(h.initialTarget)
  h.onScene(() => {})
  original[1].transmission = 0
  h.pipeline.render(new THREE.PerspectiveCamera())
  expect(h.state.reads).toBe(0)
  expect(h.pipeline.lastFrame.complete).toBe(true)
  expect(() => h.pipeline.setSize(0, 5)).toThrow('size')
  expect(() => h.pipeline.setSize(9000, 5)).toThrow('size')
  h.pipeline.dispose()
  h.pipeline.dispose()
  expect(() => h.pipeline.render(new THREE.PerspectiveCamera())).toThrow('disposed')
})

test('a larger finite budget permits slow warmup but still refuses overdue partial output', () => {
  const scene = new THREE.Scene()
  const h = harness(scene)
  const clock = spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(6000)
  try {
    h.pipeline.render(new THREE.PerspectiveCamera())
    expect(h.pipeline.lastFrame.complete).toBe(true)
    h.draws.length = 0
    clock.mockReset().mockReturnValueOnce(0).mockReturnValue(60_001)
    expect(() => h.pipeline.render(new THREE.PerspectiveCamera())).toThrow('no partial image was output')
    expect(h.pipeline.lastFrame.complete).toBe(false)
    expect(h.draws.some(draw => draw.target === h.pipeline.readBuffer)).toBe(false)
    expect(h.state.target).toBe(h.initialTarget)
  } finally {
    clock.mockRestore()
    h.pipeline.dispose()
  }
})

test('unchanged output size does no resize/disposal work, including 1x1 initialization', () => {
  const h = harness(new THREE.Scene())
  const resize = spyOn(THREE.WebGLRenderTarget.prototype, 'setSize')
  const dispose = spyOn(THREE.WebGLRenderTarget.prototype, 'dispose')
  try {
    for (let index = 0; index < 3; index++) h.pipeline.setSize(3, 5)
    expect(resize).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    h.pipeline.setSize(1, 1)
    expect(resize).toHaveBeenCalled()
    expect(dispose).toHaveBeenCalled()
    resize.mockClear()
    dispose.mockClear()
    h.pipeline.setSize(1, 1)
    expect(resize).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  } finally {
    resize.mockRestore()
    dispose.mockRestore()
    h.pipeline.dispose()
  }
  h.renderer.getDrawingBufferSize = value => value.set(1, 1)
  const pipeline = new RasterPipeline(h.webgl, new THREE.Scene(), { ambientOcclusion: false })
  try {
    pipeline.renderToScreen = false
    pipeline.render(new THREE.PerspectiveCamera())
    const aa = (h.draws.at(-2)?.object as THREE.Mesh).material as THREE.ShaderMaterial
    expect(aa.uniforms.resolution.value.toArray()).toEqual([1, 1])
  } finally {
    pipeline.dispose()
  }
})

test('culled layered parents skip preparation without hiding children or opaque shadow casters', () => {
  const scene = new THREE.Scene()
  const parent = new THREE.Mesh(triangles(50), new THREE.MeshPhysicalMaterial({ transmission: 1 }))
  parent.position.x = 100
  const child = new THREE.Mesh(triangles(3), new THREE.MeshPhysicalMaterial({ transmission: 0.5 }))
  child.position.x = -90
  parent.add(child)
  const excluded = new THREE.Mesh(triangles(100), new THREE.MeshPhysicalMaterial({ transmission: 1 }))
  excluded.position.x = 10
  excluded.layers.set(1)
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
  excluded.add(lines)
  const uncullable = new THREE.Mesh(triangles(2), new THREE.MeshPhysicalMaterial({ transmission: 1 }))
  uncullable.position.x = 100
  uncullable.frustumCulled = false
  const opaque = new THREE.Mesh(triangles(1), new THREE.MeshPhysicalMaterial())
  opaque.position.x = 100
  opaque.castShadow = true
  scene.add(parent, excluded, uncullable, opaque)
  const originalParent = parent.material
  const originalChild = child.material
  const originalExcluded = excluded.material
  const originalOpaque = opaque.material
  const originalLines = lines.material
  const camera = new THREE.PerspectiveCamera()
  camera.position.x = 10
  const h = harness(scene, [255, 0, 255, 0])
  const configure = spyOn(h.pipeline, 'configureMaterial')
  h.onScene(() => {
    expect(parent.visible && excluded.visible).toBe(true)
    expect(parent.material.visible || excluded.material.visible).toBe(false)
    if (opaque.material.visible) expect(opaque.material).toBe(originalOpaque)
    if (child.material.visible) expect(child.material).not.toBe(originalChild)
    if (lines.material.visible) expect(lines.material).toBe(originalLines)
  })
  try {
    h.pipeline.render(camera)
    expect(h.pipeline.lastFrame.triangleBound).toBe(5)
    expect(configure.mock.calls.map(([source]) => source)).toEqual([originalChild, uncullable.material])
    expect(parent.material).toBe(originalParent)
    expect(child.material).toBe(originalChild)
    expect(excluded.material).toBe(originalExcluded)
    expect(lines.material).toBe(originalLines)
    camera.position.x = 100
    configure.mockClear()
    h.onScene(() => {})
    h.pipeline.render(camera)
    expect(h.pipeline.lastFrame.triangleBound).toBe(52)
    expect(configure.mock.calls.map(([source]) => source)).toEqual([originalParent, uncullable.material])
  } finally {
    configure.mockRestore()
    h.pipeline.dispose()
  }
})

test('patched GTAO materials are disposed once by their owner', () => {
  const h = harness(new THREE.Scene())
  const gtao = spyOn(h.pipeline.ambientOcclusion.gtaoMaterial, 'dispose')
  const blend = spyOn(h.pipeline.ambientOcclusion.blendMaterial, 'dispose')
  try {
    h.pipeline.dispose()
    h.pipeline.dispose()
    expect(gtao).toHaveBeenCalledTimes(1)
    expect(blend).toHaveBeenCalledTimes(1)
  } finally {
    gtao.mockRestore()
    blend.mockRestore()
  }
})
