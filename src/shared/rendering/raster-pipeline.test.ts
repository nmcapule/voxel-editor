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
    autoClear: true, shadowMap: { enabled: false, autoUpdate: true, needsUpdate: true }, xr: { enabled: true },
    clippingPlanes: [] as THREE.Plane[],
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
  expect(h.pipeline.lastFrame).toEqual({ layers: 257, triangleBound: 300, occludedMeshes: 0, complete: true })
  expect(h.state.reads).toBe(258)
  expect(h.draws.at(-1)?.target).toBe(h.pipeline.readBuffer)
  h.pipeline.dispose()
})

test('layer bound counts billboard geometry instances and permits every transparent layer', () => {
  const scene = new THREE.Scene()
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', triangles(2).getAttribute('position'))
  geometry.instanceCount = 12
  const mesh = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({ opacity: 0.5, transparent: true }))
  scene.add(mesh)
  expect(transparentTriangleBound(mesh)).toBe(24)
  const h = harness(scene, [...Array<number>(12).fill(255), 0])
  h.pipeline.render(new THREE.OrthographicCamera())
  expect(h.pipeline.lastFrame).toEqual({ layers: 12, triangleBound: 24, occludedMeshes: 0, complete: true })
  geometry.instanceCount = 0
  expect(transparentTriangleBound(mesh)).toBe(0)
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
    expect(shader.fragmentShader).toContain('invariant gl_FragDepth;')
    expect(shader.fragmentShader).toContain('gl_FragDepth = gl_FragCoord.z;')
    expect(shader.fragmentShader).toMatch(/gl_FragDepth = gl_FragCoord.z;\s*\/\/ voxel-fragment-depth/)
    expect(shader.fragmentShader.indexOf('gl_FragDepth = gl_FragCoord.z;')).toBeLessThan(shader.fragmentShader.indexOf('discard;'))
    expect(shader.fragmentShader).not.toContain('transmissionSamplerMap')
    expect(shader.fragmentShader).toContain('rasterTransmissionMap')
    expect(shader.uniforms.transmission.value).toBe(source.transmission)
    expect(shader.uniforms.thickness.value).toBe(1.2)
    expect(shader.uniforms.attenuationDistance.value).toBe(4)
    expect(shader.uniforms.transmissionMapTransform.value).toBe(transmissionMap.matrix)
    expect(shader.uniforms.customSourceUniform.value).toBe(42)
    if (material.depthFunc === THREE.GreaterEqualDepth) {
      expect(material.blending).toBe(THREE.NoBlending)
      expect(shader.fragmentShader).toContain('gl_FragDepth >= texelFetch(rasterPreviousDepth')
    } else {
      expect(shader.fragmentShader).toContain('gl_FragDepth != texelFetch(rasterSelectedDepth')
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
    source.envMapRotation.set(0, 0.7, 0)
    source.color.setHex(0x123456)
    source.needsUpdate = true
    h.onScene(() => {
      const material = mesh.material
      if (!material.visible) return
      expect(material.version).toBeGreaterThan(versions.get(material)!)
      expect(material.roughness).toBe(0.6)
      expect(material.envMapIntensity).toBe(0.9)
      expect(material.envMapRotation.equals(source.envMapRotation)).toBe(true)
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

test('non-PBR raster uses cached opaque palette materials without changing sources, helpers or geometry', () => {
  const scene = new THREE.Scene(), geometry = triangles(2)
  geometry.addGroup(0, 6, 0)
  const map = new THREE.Texture()
  const source = new THREE.MeshPhysicalMaterial({ color: 0x123456, transmission: 0.8, opacity: 0.4,
    transparent: true, metalness: 1, emissive: 0xffffff, emissiveIntensity: 3,
    map, normalMap: map, roughnessMap: map, metalnessMap: map })
  const mesh = new THREE.Mesh(geometry, [source] as THREE.Material[])
  const offscreen = new THREE.Mesh(geometry, source as THREE.Material)
  offscreen.position.x = 100
  const overlay = new THREE.Mesh(geometry, source as THREE.Material)
  overlay.userData.editorOverlay = true
  const basic = new THREE.MeshBasicMaterial(), context = new THREE.Mesh(geometry, basic as THREE.Material)
  scene.add(mesh, offscreen, overlay, context)
  const original = mesh.material, h = harness(scene), camera = new THREE.OrthographicCamera()
  let diffuse: THREE.MeshLambertMaterial | undefined, disposed = 0
  h.pipeline.pbrMaterials = false
  h.onScene(() => {
    if (mesh.material[0].visible) {
      const material = mesh.material[0] as THREE.MeshLambertMaterial
      expect(material).toBeInstanceOf(THREE.MeshLambertMaterial)
      expect(material.color.equals(source.color)).toBe(true)
      expect(material.opacity).toBe(1)
      expect(material.transparent).toBe(false)
      expect(material.map || material.normalMap || material.envMap).toBeNull()
      expect(material.emissive.getHex()).toBe(0)
      expect(offscreen.material).toBe(material)
      expect(mesh.castShadow && offscreen.castShadow).toBe(true)
      expect(context.material).toBe(basic)
      if (diffuse) expect(material).toBe(diffuse)
      else { diffuse = material; material.addEventListener('dispose', () => disposed++) }
    } else expect(overlay.material).toBe(source)
  })
  try {
    h.pipeline.render(camera)
    const version = diffuse!.version
    h.pipeline.render(camera)
    expect(diffuse!.version).toBe(version)
    source.color.setHex(0xabcdef)
    source.roughness = 0.8
    source.needsUpdate = true
    h.pipeline.render(camera)
    expect(h.pipeline.lastFrame).toEqual({ layers: 0, triangleBound: 0, occludedMeshes: 0, complete: true })
    expect(h.state.reads).toBe(0)
    expect(mesh.material).toBe(original)
    expect(mesh.geometry).toBe(geometry)
    expect(mesh.castShadow || offscreen.castShadow).toBe(false)
    expect(source.map).toBe(map)
    expect(source.transmission).toBe(0.8)
    expect(source.opacity).toBe(0.4)
    h.onScene(() => { throw new Error('diffuse draw failure') })
    expect(() => h.pipeline.render(camera)).toThrow('diffuse draw failure')
    expect(mesh.material).toBe(original)
    expect(mesh.castShadow || offscreen.castShadow).toBe(false)
    h.onScene(() => {})
    h.pipeline.pbrMaterials = true
    h.pipeline.render(camera)
    expect(h.pipeline.lastFrame.triangleBound).toBe(2)
    expect(mesh.material).toBe(original)
    source.dispose()
    expect(disposed).toBe(1)
  } finally {
    h.pipeline.dispose(); geometry.dispose(); basic.dispose(); map.dispose()
  }
  expect(disposed).toBe(1)
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

test('opaque culling receives current matrices, raster pixels and only visible in-frustum eligible draws', () => {
  const scene = new THREE.Scene(), group = new THREE.Group(), camera = new THREE.OrthographicCamera()
  const map = new THREE.Texture()
  const sources = [new THREE.MeshBasicMaterial({ map, alphaMap: map }), new THREE.MeshLambertMaterial({ normalMap: map }),
    new THREE.MeshStandardMaterial({ map, normalMap: map, depthFunc: THREE.LessDepth }), new THREE.MeshPhysicalMaterial()]
  const eligible = sources.map(source => new THREE.Mesh(triangles(1), source))
  const excluded = Array.from({ length: 7 }, () => new THREE.Mesh(triangles(1), new THREE.MeshBasicMaterial()))
  excluded[0].visible = false
  excluded[1].material.visible = false
  excluded[2].layers.set(1)
  excluded[3].position.x = 100
  excluded[4].position.x = 100
  excluded[4].frustumCulled = false
  excluded[5].geometry.setDrawRange(0, 0)
  excluded[6].geometry.setDrawRange(3, 3)
  const invisible = new THREE.Group(), invisibleChild = new THREE.Mesh(triangles(1), sources[0])
  invisible.visible = false
  invisible.add(invisibleChild)
  group.add(...eligible, ...excluded, invisible)
  group.position.x = 12
  camera.position.x = 12
  scene.add(group)
  const h = harness(scene), target = new THREE.WebGLRenderTarget(1, 1)
  const frames: ReadonlySet<THREE.Mesh>[] = []
  try {
    for (const [width, height] of [[11, 13], [5, 7]]) {
      h.pipeline.setSize(width, height)
      const output = h.pipeline.render(camera, target, frame => {
        expect(frame.camera).toBe(camera)
        expect([frame.width, frame.height]).toEqual([width, height])
        expect(camera.matrixWorld.elements[12]).toBe(12)
        expect(camera.matrixWorldInverse.elements[12]).toBe(-12)
        expect(eligible.every(mesh => mesh.matrixWorld.elements[12] === 12)).toBe(true)
        expect([...frame.opaqueMeshes]).toEqual(eligible)
        expect(eligible.map(mesh => mesh.material)).toEqual(sources)
        expect(h.draws.filter(draw => draw.object === scene)).toHaveLength(frames.length * 2)
        frames.push(frame.opaqueMeshes)
        return new Set([...eligible, ...excluded, invisibleChild])
      })
      expect(output).toBe(target)
      expect(h.pipeline.lastFrame.occludedMeshes).toBe(4)
      expect(eligible.map(mesh => mesh.material)).toEqual(sources)
    }
    expect(frames[0]).not.toBe(frames[1])
  } finally {
    h.pipeline.dispose(); target.dispose(); map.dispose()
  }
})

test('opaque eligibility uses effective non-PBR materials, without admitting overlays or deformed meshes', () => {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera()
  const source = new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.4, transmission: 1,
    depthTest: false, depthWrite: false, depthFunc: THREE.AlwaysDepth, alphaTest: 0.5, wireframe: true, displacementMap: new THREE.Texture() })
  source.onBeforeCompile = () => {}
  const mesh = new THREE.Mesh(triangles(1), source as THREE.Material)
  const overlay = new THREE.Mesh(triangles(1), source as THREE.Material)
  overlay.userData.editorOverlay = true
  const deformed = new THREE.Mesh(triangles(1), source as THREE.Material)
  deformed.geometry.morphAttributes.position = [triangles(1).getAttribute('position')]
  const h = harness(scene)
  scene.add(mesh, overlay, deformed)
  h.pipeline.pbrMaterials = false
  try {
    h.pipeline.render(camera, undefined, frame => {
      expect([...frame.opaqueMeshes]).toEqual([mesh])
      expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial)
      expect(mesh.material).toMatchObject({ transparent: false, opacity: 1, depthTest: true, depthWrite: true,
        depthFunc: THREE.LessEqualDepth, alphaTest: 0, wireframe: false, displacementMap: null })
      expect(overlay.material).toBe(source)
      expect(mesh.castShadow).toBe(true)
      return new Set([mesh, overlay, deformed])
    })
    expect(h.pipeline.lastFrame).toEqual({ layers: 0, triangleBound: 0, occludedMeshes: 1, complete: true })
    expect(mesh.material).toBe(source)
    expect(mesh.castShadow).toBe(false)
    h.pipeline.pbrMaterials = true
    h.pipeline.render(camera, undefined, frame => {
      expect(frame.opaqueMeshes.size).toBe(0)
      return new Set([mesh])
    })
    expect(h.pipeline.lastFrame.occludedMeshes).toBe(0)
    expect(h.pipeline.lastFrame.triangleBound).toBe(2)
  } finally {
    h.pipeline.dispose(); source.displacementMap!.dispose()
  }
})

test('opaque culling is pass-local, identity-guarded and preserves opaque, glass and overlay descendants', () => {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(), source = new THREE.MeshBasicMaterial()
  const parent = new THREE.Mesh(triangles(1), source), sibling = new THREE.Mesh(triangles(1), source)
  const child = new THREE.Mesh(triangles(1), source)
  const glass = new THREE.Mesh(triangles(2), new THREE.MeshPhysicalMaterial({ transmission: 1 }))
  const lines = new THREE.LineSegments(triangles(1), new THREE.LineBasicMaterial())
  const context = new THREE.Mesh(triangles(1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false }))
  const overlay = new THREE.Mesh(triangles(1), new THREE.MeshBasicMaterial({ depthTest: false, depthFunc: THREE.AlwaysDepth }))
  const overlayGroup = new THREE.Group()
  overlayGroup.userData.editorOverlay = true
  overlayGroup.add(context, overlay)
  const unsupported = new THREE.Mesh(triangles(1), new THREE.MeshBasicMaterial({ wireframe: true }))
  const unrelated = new THREE.Mesh(triangles(1), source)
  parent.add(child, glass, lines, overlayGroup)
  scene.add(parent, sibling, unsupported)
  const originals = [glass.material, lines.material, context.material, overlay.material, unsupported.material] as const
  const h = harness(scene, [255, 0]), phases: boolean[][] = []
  let culling = true
  h.onScene(() => {
    phases.push([parent.material.visible, child.material.visible, glass.material.visible, lines.material.visible, context.material.visible])
    expect(parent.visible && child.visible && glass.visible).toBe(true)
    expect(parent.layers.mask).toBe(1)
    expect(source.visible).toBe(true)
    expect(unrelated.material).toBe(source)
    if (phases.length === 1) {
      expect(parent.material.visible).toBe(!culling)
      expect(sibling.material).toBe(source)
      expect(child.material).toBe(source)
      expect(unsupported.material).toBe(originals[4])
    }
    if (lines.material.visible) {
      expect([lines.material, context.material, overlay.material]).toEqual([originals[1], originals[2], originals[3]])
    }
  })
  try {
    h.pipeline.render(camera, undefined, frame => {
      expect([...frame.opaqueMeshes]).toEqual([parent, child, sibling])
      // Even a runtime violation of ReadonlySet must not expand pipeline eligibility.
      for (const mesh of [glass, context, overlay, unsupported, unrelated]) (frame.opaqueMeshes as Set<THREE.Mesh>).add(mesh)
      return new Set([parent, glass, context, overlay, unsupported, unrelated])
    })
    expect(phases).toEqual([[false, true, false, false, false], [false, false, true, false, false],
      [false, false, true, false, false], [false, false, true, false, false], [false, false, false, true, true]])
    expect(h.pipeline.lastFrame).toEqual({ layers: 1, triangleBound: 2, occludedMeshes: 1, complete: true })
    expect(parent.material).toBe(source)
    expect([glass.material, lines.material, context.material, overlay.material, unsupported.material]).toEqual([...originals])
    culling = false
    for (const provider of [undefined, () => undefined]) {
      phases.length = 0
      h.pipeline.render(camera, undefined, provider)
      expect(phases[0][0]).toBe(true)
      expect(h.pipeline.lastFrame.occludedMeshes).toBe(0)
    }
  } finally {
    h.pipeline.dispose()
  }
})

test.each([
  [true, true, true], [true, true, false], [true, false, true], [true, false, false],
  [false, true, true], [false, true, false], [false, false, true], [false, false, false],
])('opaque culling respects shadow enabled=%s autoUpdate=%s needsUpdate=%s', (enabled, autoUpdate, needsUpdate) => {
  const scene = new THREE.Scene(), mesh = new THREE.Mesh(triangles(1), new THREE.MeshStandardMaterial())
  mesh.castShadow = true
  scene.add(mesh)
  const h = harness(scene), source = mesh.material, bypass = enabled && (autoUpdate || needsUpdate)
  Object.assign(h.renderer.shadowMap, { enabled, autoUpdate, needsUpdate })
  let calls = 0, draws = 0
  h.onScene(() => {
    if (draws++ !== 0) return
    expect(h.renderer.shadowMap).toEqual({ enabled, autoUpdate, needsUpdate })
    expect(mesh.material.visible).toBe(bypass)
    expect(mesh.castShadow).toBe(true)
  })
  try {
    h.pipeline.render(new THREE.OrthographicCamera(), undefined, () => {
      calls++
      expect(h.renderer.shadowMap).toEqual({ enabled, autoUpdate, needsUpdate })
      return new Set([mesh])
    })
    expect(calls).toBe(bypass ? 0 : 1)
    expect(h.pipeline.lastFrame.occludedMeshes).toBe(bypass ? 0 : 1)
    expect(mesh.material).toBe(source)
    expect(h.renderer.shadowMap.enabled).toBe(enabled)
    expect(h.renderer.shadowMap.autoUpdate).toBe(autoUpdate)
  } finally {
    h.pipeline.dispose()
  }
})

test.each(['callback', 'opaque', 'peel', 'overlay'])('opaque culling restores sources and renderer after %s throws, then resets on retry', failure => {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera()
  const source = new THREE.MeshPhysicalMaterial({ transmission: 1 }), mesh = new THREE.Mesh(triangles(1), source as THREE.Material)
  const glass = new THREE.Mesh(triangles(1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 }))
  scene.background = new THREE.Color(0xabcdef)
  scene.overrideMaterial = new THREE.MeshNormalMaterial()
  scene.add(mesh, glass)
  const background = scene.background, override = scene.overrideMaterial, originalGlass = glass.material
  const h = harness(scene)
  h.pipeline.pbrMaterials = false
  let draws = 0
  h.onScene(() => {
    const phase = ['opaque', 'peel', 'overlay'][draws++]
    if (phase === failure) throw new Error('culling failure')
  })
  try {
    expect(() => h.pipeline.render(camera, undefined, frame => {
      expect([...frame.opaqueMeshes]).toEqual([mesh])
      expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial)
      if (failure === 'callback') throw new Error('culling failure')
      return new Set([mesh])
    })).toThrow('culling failure')
    expect(h.pipeline.lastFrame.complete).toBe(false)
    expect(h.draws.some(draw => draw.target === h.pipeline.readBuffer)).toBe(false)
    expect(mesh.material).toBe(source)
    expect(mesh.castShadow).toBe(false)
    expect(mesh.visible && source.visible).toBe(true)
    expect(glass.material).toBe(originalGlass)
    expect(scene.background).toBe(background)
    expect(scene.overrideMaterial).toBe(override)
    expect(h.renderer.shadowMap).toEqual({ enabled: false, autoUpdate: true, needsUpdate: true })
    expect(h.renderer.autoClear && h.renderer.xr.enabled).toBe(true)
    expect(h.renderer.toneMapping).toBe(THREE.ReinhardToneMapping)
    expect(h.renderer.outputColorSpace).toBe(THREE.LinearSRGBColorSpace)
    expect(h.state.target).toBe(h.initialTarget)
    expect(h.state.viewport.toArray()).toEqual([2, 3, 7, 9])
    expect(h.state.scissor.toArray()).toEqual([1, 2, 5, 6])
    expect([h.state.face, h.state.mip, h.state.scissorTest, h.state.clearDepth, h.state.clearAlpha]).toEqual([2, 1, true, 0.9, 0.7])
    expect(h.state.clearColor.getHex()).toBe(0x123456)
    h.onScene(() => {})
    h.pipeline.render(camera)
    expect(h.pipeline.lastFrame).toEqual({ layers: 0, triangleBound: 1, occludedMeshes: 0, complete: true })
  } finally {
    h.pipeline.dispose()
  }
})

test('mixed unsupported opaque properties fail open without bypassing ordinary stage floors', () => {
  const scene = new THREE.Scene(), geometry = triangles(1), texture = new THREE.Texture()
  const safe = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  const floor = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }))
  floor.receiveShadow = true
  const unsupported: THREE.Mesh[] = [floor, ...[
    { alphaTest: 0.5 }, { alphaHash: true }, { alphaToCoverage: true }, { wireframe: true },
    { displacementMap: texture }, { clippingPlanes: [new THREE.Plane()] }, { polygonOffset: true },
    { side: THREE.BackSide }, { depthWrite: false }, { blending: THREE.AdditiveBlending },
    { transparent: true }, { opacity: 0.5 },
  ].map(options => new THREE.Mesh(geometry, new THREE.MeshStandardMaterial(options))),
  new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({ transmission: 1 })),
  new THREE.Mesh(geometry, new THREE.MeshPhongMaterial()),
  new THREE.Mesh(geometry, [safe.material]),
  new (class CustomMesh extends THREE.Mesh {})(geometry, safe.material)]
  const instances = new THREE.InstancedMesh(geometry, safe.material, 1)
  instances.setMatrixAt(0, new THREE.Matrix4())
  const skinned = new THREE.SkinnedMesh(geometry, safe.material)
  geometry.computeBoundingSphere()
  skinned.boundingSphere = geometry.boundingSphere!.clone()
  const instancedGeometry = new THREE.InstancedBufferGeometry()
  instancedGeometry.setAttribute('position', geometry.getAttribute('position'))
  instancedGeometry.instanceCount = 1
  const morph = new THREE.Mesh(triangles(1), safe.material)
  morph.geometry.morphAttributes.position = [geometry.getAttribute('position')]
  const customVertex = new THREE.Mesh(geometry, safe.material)
  customVertex.getVertexPosition = (_index, target) => target.set(0, 0, -1)
  unsupported.push(instances, skinned, new THREE.Mesh(instancedGeometry, safe.material), morph, customVertex)
  scene.add(safe, ...unsupported)
  const originals = unsupported.map(mesh => mesh.material), h = harness(scene)
  let draws = 0, calls = 0
  h.onScene(() => {
    if (draws++ !== 0) return
    expect(safe.material.visible).toBe(false)
    for (const [index, mesh] of unsupported.entries()) {
      const source = originals[index]
      if (Array.isArray(source)) expect(mesh.material).toEqual(source)
      else if (!source.transparent && source.opacity === 1 && !(source as THREE.MeshPhysicalMaterial).transmission) expect(mesh.material).toBe(source)
    }
  })
  try {
    h.pipeline.render(new THREE.OrthographicCamera(), undefined, frame => {
      calls++
      expect([...frame.opaqueMeshes]).toEqual([safe])
      return new Set([safe, ...unsupported])
    })
    expect(calls).toBe(1)
    expect(h.pipeline.lastFrame.occludedMeshes).toBe(1)
    expect(unsupported.map(mesh => mesh.material)).toEqual(originals)
  } finally {
    h.pipeline.dispose(); texture.dispose()
  }
})

test.each([
  ['never depth', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).depthFunc = THREE.NeverDepth }],
  ['always depth', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).depthFunc = THREE.AlwaysDepth }],
  ['equal depth', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).depthFunc = THREE.EqualDepth }],
  ['greater depth', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).depthFunc = THREE.GreaterDepth }],
  ['greater-equal depth', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).depthFunc = THREE.GreaterEqualDepth }],
  ['not-equal depth', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).depthFunc = THREE.NotEqualDepth }],
  ['disabled depth test', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).depthTest = false }],
  ['custom fragment depth', (mesh: THREE.Mesh) => { mesh.material = new THREE.ShaderMaterial({ fragmentShader: 'void main() { gl_FragDepth = 1.0; }' }) }],
  ['raw shader', (mesh: THREE.Mesh) => { mesh.material = new THREE.RawShaderMaterial() }],
  ['custom material', (mesh: THREE.Mesh) => { mesh.material = new (class CustomMaterial extends THREE.MeshStandardMaterial {})() }],
  ['shader callback', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).onBeforeCompile = () => {} }],
  ['material callback', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).onBeforeRender = () => {} }],
  ['program key', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).customProgramCacheKey = () => 'custom' }],
  ['custom defines', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).defines = { USE_DISPLACEMENTMAP: '' } }],
  ['before-render callback', (mesh: THREE.Mesh) => { mesh.onBeforeRender = () => {} }],
  ['after-render callback', (mesh: THREE.Mesh) => { mesh.onAfterRender = () => {} }],
  ['stencil', (mesh: THREE.Mesh) => { (mesh.material as THREE.Material).stencilWrite = true }],
] as const)('unsafe opaque %s bypasses the provider even in mixed material arrays', (_name, configure) => {
  const scene = new THREE.Scene(), geometry = triangles(2), safe = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  const hazard = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial() as THREE.Material | THREE.Material[])
  configure(hazard)
  const unsafeMaterial = hazard.material as THREE.Material
  hazard.material = [safe.material, unsafeMaterial]
  geometry.addGroup(0, 3, 0)
  geometry.addGroup(3, 3, 1)
  scene.add(safe, hazard)
  const h = harness(scene), source = safe.material
  let calls = 0, draws = 0
  h.onScene(() => {
    if (draws++ === 0) expect(safe.material).toBe(source)
  })
  try {
    h.pipeline.render(new THREE.OrthographicCamera(), undefined, () => { calls++; return new Set([safe, hazard]) })
    expect(calls).toBe(0)
    expect(h.pipeline.lastFrame.occludedMeshes).toBe(0)
    expect(safe.material).toBe(source)
    expect(hazard.material).toEqual([source, unsafeMaterial])
  } finally {
    h.pipeline.dispose()
  }
})

test.each(['global clipping', 'scene before-render', 'scene after-render'])('%s bypasses opaque culling', hazard => {
  const scene = new THREE.Scene(), mesh = new THREE.Mesh(triangles(1), new THREE.MeshBasicMaterial())
  scene.add(mesh)
  const h = harness(scene)
  if (hazard === 'global clipping') h.renderer.clippingPlanes.push(new THREE.Plane())
  if (hazard === 'scene before-render') scene.onBeforeRender = () => {}
  if (hazard === 'scene after-render') scene.onAfterRender = () => {}
  let calls = 0
  try {
    h.pipeline.render(new THREE.OrthographicCamera(), undefined, () => { calls++; return new Set([mesh]) })
    expect(calls).toBe(0)
    expect(h.pipeline.lastFrame.occludedMeshes).toBe(0)
  } finally {
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
