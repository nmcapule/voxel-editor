import * as THREE from 'three'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import type { SceneContent } from './contracts'

type Surface = THREE.Mesh | THREE.Line | THREE.Points | THREE.Sprite
type Phase = 'opaque' | 'peel' | 'shade' | 'overlay'

function isLayered(material: THREE.Material) {
  return material.transparent || material.opacity < 1
    || (material as THREE.MeshPhysicalMaterial).transmission > 0
}

/** Conservative bound, not a quality setting: a triangle covers a sample at most once. */
export function transparentTriangleBound(mesh: THREE.Mesh) {
  const geometry = mesh.geometry
  const count = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0
  const { start, count: drawCount } = geometry.drawRange
  const end = Math.min(count, start + drawCount)
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }]
  let triangles = 0
  for (const group of groups) {
    const material = materials[group.materialIndex ?? 0]
    if (!material?.visible || !isLayered(material)) continue
    triangles += Math.ceil(Math.max(0, Math.min(end, group.start + group.count) - Math.max(start, group.start)) / 3)
  }
  const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count
    : (geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry ? (geometry as THREE.InstancedBufferGeometry).instanceCount : 1
  return triangles * instances
}

const fullscreenVertex = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

function fullscreen(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: fullscreenVertex, fragmentShader, uniforms,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  })
}

function colorTarget(depthBuffer = false) {
  return new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer,
    ...(depthBuffer ? { depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType) } : {}),
  })
}

function peelTarget() {
  return new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
  })
}

interface MaterialVariants {
  sourceVersion: number
  peel: THREE.Material
  shade: THREE.Material
  uniforms: Record<string, THREE.IUniform>
  dispose: () => void
}

export interface RasterPipelineOptions {
  ambientOcclusion?: boolean
  /** FXAA after overlays: perceptual edge detection, linear-light filtering. Default true. */
  antialias?: boolean
  /** Default 5000ms, including shader compilation. CI/software GPUs can use a larger finite budget. */
  maxFrameMilliseconds?: number
}

/**
 * WebGL2, conventional (not logarithmic/reversed) depth, triangle voxel surfaces.
 * setSize takes OUTPUT PIXELS, not CSS pixels. It never resizes the canvas or camera.
 * render(camera) draws to the canvas; renderToScreen=false writes readBuffer instead.
 * readBuffer contains OutputPass ACES/sRGB values in HalfFloat storage, like EffectComposer.
 * An explicit render target overrides renderToScreen. Caller owns its size and lifetime.
 * Source materials are never patched; configureMaterial is optional, render registers them.
 * Set source.needsUpdate=true after material edits, including scalars/colors/environment intensity.
 * Existing texture image and transform updates do not require a material version change.
 * Remove the old per-mesh transmission-copy and material-sorting hooks on integration.
 * Distinct raster depths are peeled exactly; coincident same-facing ties remain ambiguous.
 * FrontSide watertight voxel interfaces avoid duplicate opposing coplanar faces.
 * Refraction/roughness retain Three's screen-space approximation, not ray-traced visibility.
 */
export class RasterPipeline {
  readonly ambientOcclusion: GTAOPass
  readonly readBuffer = colorTarget()
  renderToScreen = true
  /** False substitutes opaque palette-only diffuse shading for physical mesh materials. */
  pbrMaterials = true
  readonly lastFrame = { layers: 0, triangleBound: 0, occludedMeshes: 0, complete: false }

  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  antialias: boolean
  private readonly maxFrameMilliseconds: number
  private readonly beauty = colorTarget(true)
  private readonly scratch = colorTarget()
  private readonly peels = [peelTarget(), peelTarget()]
  private readonly snapshot = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true, depthBuffer: false,
  })
  private readonly reductions: THREE.WebGLRenderTarget[] = []
  private readonly pixel = new Uint8Array(4)
  private readonly hidden = new THREE.MeshBasicMaterial({ visible: false })
  private readonly variants = new Map<THREE.Material, MaterialVariants>()
  private readonly diffuse = new Map<THREE.MeshStandardMaterial, { version: number; material: THREE.MeshLambertMaterial; dispose: () => void }>()
  private readonly uniforms = {
    rasterOpaqueDepth: { value: this.beauty.depthTexture },
    rasterPreviousDepth: { value: this.beauty.depthTexture },
    rasterSelectedDepth: { value: this.peels[0].depthTexture },
    rasterSelectedMask: { value: this.peels[0].texture },
    rasterTransmissionMap: { value: this.snapshot.texture },
    rasterTransmissionSize: { value: new THREE.Vector2() },
  }
  private readonly copy = fullscreen(`
    uniform sampler2D image;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(image, vUv); }
  `, { image: { value: null } })
  private readonly reduce = fullscreen(`
    uniform sampler2D image;
    void main() {
      ivec2 origin = ivec2(gl_FragCoord.xy) * 2;
      ivec2 size = textureSize(image, 0);
      float occupied = 0.0;
      for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
        ivec2 p = origin + ivec2(x, y);
        if (all(lessThan(p, size))) occupied = max(occupied, texelFetch(image, p, 0).r);
      }
      gl_FragColor = vec4(occupied, 0.0, 0.0, 1.0);
    }
  `, { image: { value: null } })
  private readonly aa = fullscreen(`
    #include <tonemapping_pars_fragment>
    ${FXAAShader.fragmentShader.replace(
      'return dot( Sample( tex2D, uv ).rgb, vec3( 0.3, 0.59, 0.11 ) );',
      'return dot(sRGBTransferOETF(vec4(ACESFilmicToneMapping(Sample(tex2D, uv).rgb), 1.0)).rgb, vec3(0.3, 0.59, 0.11));',
    )}
  `, { ...THREE.UniformsUtils.clone(FXAAShader.uniforms), toneMappingExposure: { value: 1 } })
  private readonly quad = new FullScreenQuad(this.copy)
  private readonly output = new OutputPass()
  private disposed = false
  private rendering = false

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, options: RasterPipelineOptions = {}) {
    this.renderer = renderer
    this.scene = scene
    this.antialias = options.antialias ?? true
    this.maxFrameMilliseconds = options.maxFrameMilliseconds ?? 5000
    if (!(this.maxFrameMilliseconds > 0) || !Number.isFinite(this.maxFrameMilliseconds)) {
      throw new Error('RasterPipeline: maxFrameMilliseconds must be positive and finite.')
    }
    if (renderer.capabilities.logarithmicDepthBuffer || renderer.capabilities.reversedDepthBuffer) {
      throw new Error('RasterPipeline requires conventional WebGL depth.')
    }
    this.ambientOcclusion = new GTAOPass(scene, new THREE.PerspectiveCamera(), 1, 1)
    // Reconstruct normals from the actual opaque beauty depth. No override render of glass/helpers.
    // Call after construction: Three r185 setGBuffer needs its internal normal target to exist.
    this.ambientOcclusion.setGBuffer(this.beauty.depthTexture!)
    this.ambientOcclusion.updateGtaoMaterial({ radius: 0.8, thickness: 1.1, distanceFallOff: 1, samples: 16 })
    this.ambientOcclusion.blendIntensity = 0.65
    this.ambientOcclusion.enabled = options.ambientOcclusion ?? true
    this.output.material.depthTest = false
    this.output.material.depthWrite = false
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    this.setSize(size.x, size.y)
  }

  setSize(width: number, height: number) {
    if (this.disposed || this.rendering) throw new Error('RasterPipeline cannot resize while rendering or after disposal.')
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)
      || Math.max(width, height) > this.renderer.capabilities.maxTextureSize) {
      throw new Error('RasterPipeline size exceeds the supported positive pixel dimensions.')
    }
    if (this.uniforms.rasterTransmissionSize.value.x === width && this.uniforms.rasterTransmissionSize.value.y === height) return
    this.readBuffer.setSize(width, height)
    for (const target of [this.beauty, this.scratch, this.snapshot, ...this.peels]) target.setSize(width, height)
    this.aa.uniforms.resolution.value.set(1 / width, 1 / height)
    this.uniforms.rasterTransmissionSize.value.set(width, height)
    this.ambientOcclusion.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)))
    for (const target of this.reductions) target.dispose()
    this.reductions.length = 0
    while (width > 1 || height > 1) {
      width = Math.ceil(width / 2)
      height = Math.ceil(height / 2)
      this.reductions.push(new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      }))
    }
  }

  configureMaterial(source: THREE.Material) {
    if (this.disposed) throw new Error('RasterPipeline is disposed.')
    if (this.variants.has(source)) return
    if ((source as THREE.ShaderMaterial).isShaderMaterial) {
      throw new Error('RasterPipeline layered surfaces require a built-in Three mesh material.')
    }
    const uniforms: Record<string, THREE.IUniform> = {}
    const peel = source.clone()
    const shade = source.clone()
    const dispose = () => {
      peel.dispose()
      shade.dispose()
      source.removeEventListener('dispose', dispose)
      this.variants.delete(source)
    }
    source.addEventListener('dispose', dispose)
    for (const [material, selecting] of [[peel, true], [shade, false]] as const) {
      material.customProgramCacheKey = () => `raster-peel-v1:${selecting}:${source.customProgramCacheKey()}`
      material.onBeforeCompile = (shader, renderer) => {
        Object.assign(shader.uniforms, this.uniforms, uniforms)
        shader.vertexShader = 'invariant gl_Position;\n' + shader.vertexShader
        const declarations = selecting ? `
          uniform sampler2D rasterOpaqueDepth;
          uniform sampler2D rasterPreviousDepth;
        ` : `
          uniform sampler2D rasterSelectedDepth;
          uniform sampler2D rasterSelectedMask;
        `
        const reject = selecting ? `
          if (gl_FragDepth >= texelFetch(rasterOpaqueDepth, rasterPixel, 0).r
            || gl_FragDepth >= texelFetch(rasterPreviousDepth, rasterPixel, 0).r) discard;
        ` : `
          if (texelFetch(rasterSelectedMask, rasterPixel, 0).r == 0.0
            || gl_FragDepth != texelFetch(rasterSelectedDepth, rasterPixel, 0).r) discard;
        `
        if (!shader.fragmentShader.includes('#include <alphahash_fragment>')) {
          throw new Error('RasterPipeline: unsupported material shader (missing alpha stage).')
        }
        // Exact peeling must compare and write the same invariant depth in both programs.
        // Impostor callbacks replace the assignment/marker before any layer comparison.
        shader.fragmentShader = 'invariant gl_FragDepth;\n' + declarations + shader.fragmentShader.replace('void main() {', `
          void main() {
            gl_FragDepth = gl_FragCoord.z;
            // voxel-fragment-depth
            ivec2 rasterPixel = ivec2(gl_FragCoord.xy);
            ${reject}
        `).replace('#include <alphahash_fragment>', `
          #include <alphahash_fragment>
          if (diffuseColor.a <= 0.0) discard;
          ${selecting ? 'gl_FragColor = vec4(1.0); return;' : ''}
        `).replace('#include <transmission_pars_fragment>', THREE.ShaderChunk.transmission_pars_fragment
          .replaceAll('transmissionSamplerMap', 'rasterTransmissionMap')
          .replaceAll('transmissionSamplerSize', 'rasterTransmissionSize')
          // Three's bicubic lookup asks for lod+1, including above the last level at high roughness.
          .replace('int( lod + 1.0 )', 'min(int(lod + 1.0), int(floor(log2(max(rasterTransmissionSize.x, rasterTransmissionSize.y)))))'))
        source.onBeforeCompile.call(material, shader, renderer)
      }
    }
    this.variants.set(source, { sourceVersion: -1, peel, shade, uniforms, dispose })
  }

  private updateMaterial(source: THREE.Material) {
    this.configureMaterial(source)
    const entry = this.variants.get(source)!
    const physical = source as THREE.MeshPhysicalMaterial
    for (const texture of [physical.transmissionMap, physical.thicknessMap]) {
      if (texture?.matrixAutoUpdate) texture.updateMatrix()
    }
    if (entry.sourceVersion === source.version) return
    const values: Record<string, unknown> = {
      transmission: physical.transmission, thickness: physical.thickness,
      attenuationDistance: physical.attenuationDistance, attenuationColor: physical.attenuationColor,
      transmissionMap: physical.transmissionMap, thicknessMap: physical.thicknessMap,
      transmissionMapTransform: physical.transmissionMap?.matrix, thicknessMapTransform: physical.thicknessMap?.matrix,
    }
    for (const [name, value] of Object.entries(values)) {
      if (entry.uniforms[name]) entry.uniforms[name].value = value
      else entry.uniforms[name] = { value }
    }
    for (const [material, selecting] of [[entry.peel, true], [entry.shade, false]] as const) {
      material.copy(source)
      const variant = material as THREE.MeshPhysicalMaterial
      variant.defines = { ...physical.defines }
      // Keep the entire physical shader and its transmission uniforms, but schedule in ONE list.
      // Setting only transmission=0 would lose refraction, maps, thickness and attenuation.
      if (physical.transmission > 0) {
        variant.transmission = 0
        variant.defines.USE_TRANSMISSION = ''
        for (const [map, name] of [[physical.transmissionMap, 'TRANSMISSIONMAP'], [physical.thicknessMap, 'THICKNESSMAP']] as const) {
          if (!map) continue
          variant.defines[`USE_${name}`] = ''
          variant.defines[`${name}_UV`] = map.channel === 0 ? 'uv' : `uv${map.channel}`
          if (map.channel > 0) variant.defines[`USE_UV${map.channel}`] = ''
        }
      }
      material.transparent = !selecting
      material.blending = selecting ? THREE.NoBlending : source.blending
      material.depthTest = true
      material.depthWrite = selecting || source.depthWrite
      material.depthFunc = selecting ? THREE.GreaterEqualDepth : THREE.LessEqualDepth
      material.forceSinglePass = true
      material.polygonOffset = false
      material.alphaToCoverage = false
      material.colorWrite = true
      material.needsUpdate = true
    }
    entry.sourceVersion = source.version
  }

  private diffuseMaterial(source: THREE.MeshStandardMaterial) {
    let entry = this.diffuse.get(source)
    if (!entry) {
      const material = new THREE.MeshLambertMaterial()
      const dispose = () => {
        material.dispose()
        source.removeEventListener('dispose', dispose)
        this.diffuse.delete(source)
      }
      source.addEventListener('dispose', dispose)
      entry = { version: -1, material, dispose }
      this.diffuse.set(source, entry)
    }
    if (entry.version !== source.version) {
      entry.material.color.copy(source.color)
      for (const key of ['side', 'shadowSide', 'vertexColors', 'flatShading', 'visible'] as const) {
        Object.assign(entry.material, { [key]: source[key] })
      }
      entry.material.needsUpdate = true
      entry.version = source.version
    }
    return entry.material
  }

  private blit(source: THREE.Texture, target: THREE.WebGLRenderTarget) {
    this.copy.uniforms.image.value = source
    this.quad.material = this.copy
    this.renderer.setRenderTarget(target)
    this.quad.render(this.renderer)
  }

  private occupied(target: THREE.WebGLRenderTarget) {
    this.quad.material = this.reduce
    for (const reduction of this.reductions) {
      this.reduce.uniforms.image.value = target.texture
      this.renderer.setRenderTarget(reduction)
      this.quad.render(this.renderer)
      target = reduction
    }
    // Exact OR reduction, not filtered mipmaps (a lone fragment must not disappear).
    // Synchronous 1x1 readback also avoids WebGL query availability's event-loop restriction.
    this.pixel.fill(127)
    this.renderer.readRenderTargetPixels(target, 0, 0, 1, 1, this.pixel)
    if (this.pixel[0] !== 0 && this.pixel[0] !== 255) throw new Error('RasterPipeline peel readback failed.')
    return this.pixel[0] !== 0
  }

  render(camera: THREE.Camera, target: THREE.WebGLRenderTarget | null = this.renderToScreen ? null : this.readBuffer,
    cullOpaque?: SceneContent['cullOpaque']) {
    if (this.disposed || this.rendering) throw new Error('RasterPipeline is disposed or already rendering.')
    Object.assign(this.lastFrame, { layers: 0, triangleBound: 0, occludedMeshes: 0, complete: false })
    const renderer = this.renderer
    const scene = this.scene
    const gl = renderer.getContext()
    if (gl.isContextLost()) throw new Error('RasterPipeline: WebGL context lost.')
    const started = performance.now()
    const check = () => {
      if (gl.isContextLost()) throw new Error('RasterPipeline: WebGL context lost.')
      if (performance.now() - started > this.maxFrameMilliseconds) {
        throw new Error(`RasterPipeline exceeded ${this.maxFrameMilliseconds}ms after ${this.lastFrame.layers} layers; no partial image was output.`)
      }
    }
    const saved = {
      target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
      viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()),
      scissorTest: renderer.getScissorTest(), clearColor: renderer.getClearColor(new THREE.Color()),
      clearAlpha: renderer.getClearAlpha(), clearDepth: gl.getParameter(gl.DEPTH_CLEAR_VALUE) as number,
      autoClear: renderer.autoClear, shadowAutoUpdate: renderer.shadowMap.autoUpdate,
      shadowNeedsUpdate: renderer.shadowMap.needsUpdate, xrEnabled: renderer.xr.enabled,
      background: scene.background, override: scene.overrideMaterial,
      toneMapping: renderer.toneMapping, outputColorSpace: renderer.outputColorSpace,
    }
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld()
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld()
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    const materials = new Set<THREE.Material>()
    const opaqueMeshes = new Set<THREE.Mesh>(), occludedMeshes = new Set<THREE.Mesh>()
    // The primary scene draw also updates shadows; never remove its shadow contributors.
    let cullingSafe = !!cullOpaque && !(renderer.shadowMap.enabled && (renderer.shadowMap.autoUpdate || renderer.shadowMap.needsUpdate))
      && !renderer.clippingPlanes.length
      && scene.onBeforeRender === THREE.Object3D.prototype.onBeforeRender
      && scene.onAfterRender === THREE.Object3D.prototype.onAfterRender
    const objects: { object: Surface; material: Surface['material']; rasterMaterial: Surface['material']; castShadow: boolean; overlay: boolean; visible: boolean; inView: boolean }[] = []
    const show = (phase: Phase) => {
      for (const { object, rasterMaterial, overlay, inView } of objects) {
        // Never hide a renderable parent: it may have children belonging to a different phase.
        const select = (source: THREE.Material) => {
          if (!source.visible) return source
          if (overlay) return phase === 'overlay' ? source : this.hidden
          if (!isLayered(source)) return phase === 'opaque' && !occludedMeshes.has(object as THREE.Mesh) ? source : this.hidden
          if (!inView) return this.hidden
          return phase === 'peel' || phase === 'shade' ? this.variants.get(source)![phase] : this.hidden
        }
        object.material = Array.isArray(rasterMaterial) ? rasterMaterial.map(select) : select(rasterMaterial)
      }
    }
    this.rendering = true
    try {
      scene.traverseVisible(object => {
        const surface = object as Surface
        if (!surface.material) return
        let overlay = object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite
        for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
          overlay ||= ancestor.userData.editorOverlay === true
        }
        const inView = object.layers.test(camera.layers) && (overlay || !(object instanceof THREE.Mesh)
          || !object.frustumCulled || frustum.intersectsObject(object))
        const entry = { object: surface, material: surface.material, rasterMaterial: surface.material,
          castShadow: object.castShadow, visible: object.visible, overlay, inView }
        objects.push(entry)
        if (!this.pbrMaterials && !overlay && object instanceof THREE.Mesh) {
          const select = (source: THREE.Material) => {
            if (!(source instanceof THREE.MeshStandardMaterial) || !source.visible) return source
            object.castShadow = true
            return this.diffuseMaterial(source)
          }
          // Classify opaque substitutes, including offscreen shadow casters, not authored glass.
          entry.rasterMaterial = surface.material = Array.isArray(surface.material) ? surface.material.map(select) : select(surface.material)
        }
        if (overlay || !inView) return
        if ((object as THREE.BatchedMesh).isBatchedMesh) throw new Error('RasterPipeline does not support BatchedMesh.')
        if (object instanceof THREE.Mesh) this.lastFrame.triangleBound += transparentTriangleBound(object)
        for (const source of Array.isArray(surface.material) ? surface.material : [surface.material]) {
          if (source.visible && isLayered(source)) materials.add(source)
          if (!cullingSafe || !source.visible || isLayered(source)) continue
          const conventionalDepth = source.depthFunc === THREE.LessDepth || source.depthFunc === THREE.LessEqualDepth
          const builtin = [THREE.MeshBasicMaterial, THREE.MeshLambertMaterial, THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial,
            THREE.MeshPhongMaterial, THREE.MeshToonMaterial, THREE.MeshMatcapMaterial, THREE.MeshNormalMaterial,
            THREE.MeshDepthMaterial, THREE.MeshDistanceMaterial, THREE.ShadowMaterial].some(type => source.constructor === type)
          const customDefines = Object.entries(source.defines ?? {}).some(([name, value]) => value !== '' || !(
            name === 'STANDARD' && source instanceof THREE.MeshStandardMaterial
            || name === 'PHYSICAL' && source instanceof THREE.MeshPhysicalMaterial
            || name === 'TOON' && source instanceof THREE.MeshToonMaterial
            || name === 'MATCAP' && source instanceof THREE.MeshMatcapMaterial))
          // Even an ineligible opaque draw can invalidate earlier depth evidence or callbacks.
          if (!builtin || customDefines || !conventionalDepth || !source.depthTest || source.stencilWrite
            || source.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
            || source.onBeforeRender !== THREE.Material.prototype.onBeforeRender
            || source.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
            || object.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender
            || object.onAfterRender !== THREE.Object3D.prototype.onAfterRender) {
            cullingSafe = false
            continue
          }
          if (!(object instanceof THREE.Mesh) || object.constructor !== THREE.Mesh || Array.isArray(surface.material)
            || (object.geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry
            || object.getVertexPosition !== THREE.Mesh.prototype.getVertexPosition
            || object.morphTargetInfluences?.length || Object.keys(object.geometry.morphAttributes).length
            || ![THREE.MeshBasicMaterial, THREE.MeshLambertMaterial, THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial].some(type => source.constructor === type)) continue
          const material = source as THREE.MeshStandardMaterial
          if (source.opacity !== 1 || !source.depthWrite || source.side !== THREE.FrontSide
            || ((source as THREE.MeshPhysicalMaterial).transmission !== undefined && (source as THREE.MeshPhysicalMaterial).transmission !== 0)
            || source.alphaTest !== 0 || source.alphaHash || source.alphaToCoverage || material.wireframe
            || material.displacementMap || source.clippingPlanes?.length || source.polygonOffset
            || (source.blending !== THREE.NormalBlending && source.blending !== THREE.NoBlending)) continue
          const geometry = object.geometry, { start, count } = geometry.drawRange
          const end = Math.min(geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0, start + count)
          if (end - Math.max(0, start) >= 3 && (object.frustumCulled || frustum.intersectsObject(object))) opaqueMeshes.add(object)
        }
      })
      if (!Number.isSafeInteger(this.lastFrame.triangleBound)) throw new Error('RasterPipeline triangle bound is not a safe integer.')
      for (const material of materials) this.updateMaterial(material)
      renderer.xr.enabled = false
      renderer.autoClear = false
      renderer.setScissorTest(false)
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.outputColorSpace = THREE.SRGBColorSpace
      scene.overrideMaterial = null
      renderer.state.buffers.depth.setClear(1)
      if (cullingSafe && cullOpaque) {
        const hidden = cullOpaque({ camera, width: this.beauty.width, height: this.beauty.height, opaqueMeshes: new Set(opaqueMeshes) })
        // Keep eligibility private even if a provider mutates its borrowed set at runtime.
        for (const mesh of opaqueMeshes) if (hidden?.has(mesh)) occludedMeshes.add(mesh)
        this.lastFrame.occludedMeshes = occludedMeshes.size
      }
      show('opaque')
      renderer.setRenderTarget(this.beauty)
      renderer.clear(true, true, true)
      renderer.render(scene, camera)
      // Parent invalidates shadows on geometry/light changes; no repeated shadow work per peel.
      renderer.shadowMap.autoUpdate = false
      renderer.shadowMap.needsUpdate = false
      scene.background = null
      if (this.ambientOcclusion.enabled) {
        const ao = this.ambientOcclusion
        ao.camera = camera
        const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 1 : 0
        if (ao.gtaoMaterial.defines.PERSPECTIVE_CAMERA !== perspective) {
          ao.gtaoMaterial.defines.PERSPECTIVE_CAMERA = perspective
          ao.gtaoMaterial.needsUpdate = true
        }
        ao.render(renderer, this.scratch, this.beauty, 0, false)
        this.blit(this.scratch.texture, this.beauty)
      }
      this.uniforms.rasterPreviousDepth.value = this.beauty.depthTexture
      for (let layer = 0; layer <= this.lastFrame.triangleBound && this.lastFrame.triangleBound > 0; layer++) {
        check()
        const peel = this.peels[layer % 2]
        show('peel')
        renderer.setRenderTarget(peel)
        renderer.setClearColor(0, 0)
        renderer.state.buffers.depth.setClear(0)
        renderer.clear(true, true, false)
        renderer.render(scene, camera)
        const occupied = this.occupied(peel)
        check()
        if (!occupied) break
        if (layer === this.lastFrame.triangleBound) throw new Error('RasterPipeline did not converge within its geometry-derived bound.')
        // Render a full-screen copy, rather than copyTextureToTexture: allocates all mip levels,
        // regenerates them after the copy, and never copies/samples an attached depth texture.
        this.blit(this.beauty.texture, this.snapshot)
        this.uniforms.rasterSelectedDepth.value = peel.depthTexture
        this.uniforms.rasterSelectedMask.value = peel.texture
        show('shade')
        renderer.setRenderTarget(this.beauty)
        renderer.render(scene, camera)
        this.uniforms.rasterPreviousDepth.value = peel.depthTexture
        this.lastFrame.layers++
      }
      renderer.state.buffers.depth.setClear(1)
      show('overlay')
      renderer.setRenderTarget(this.beauty)
      renderer.render(scene, camera)
      check()
      if (this.antialias) {
        // Only the edge detector sees ACES/sRGB; the filtered image stays linear until OutputPass.
        this.aa.uniforms.tDiffuse.value = this.beauty.texture
        this.aa.uniforms.toneMappingExposure.value = renderer.toneMappingExposure
        this.quad.material = this.aa
        renderer.setRenderTarget(this.scratch)
        this.quad.render(renderer)
      }
      this.output.renderToScreen = target === null
      if (target === null) {
        const size = renderer.getSize(new THREE.Vector2())
        renderer.setViewport(0, 0, size.x, size.y)
        renderer.setScissorTest(false)
      }
      this.output.render(renderer, target ?? this.readBuffer, this.antialias ? this.scratch : this.beauty, 0, false)
      this.lastFrame.complete = true
      return target
    } finally {
      for (const { object, material, visible, castShadow } of objects) {
        object.material = material
        object.visible = visible
        object.castShadow = castShadow
      }
      scene.background = saved.background
      scene.overrideMaterial = saved.override
      renderer.autoClear = saved.autoClear
      renderer.shadowMap.autoUpdate = saved.shadowAutoUpdate
      if (!this.lastFrame.complete) renderer.shadowMap.needsUpdate = saved.shadowNeedsUpdate
      renderer.xr.enabled = saved.xrEnabled
      renderer.toneMapping = saved.toneMapping
      renderer.outputColorSpace = saved.outputColorSpace
      renderer.setClearColor(saved.clearColor, saved.clearAlpha)
      renderer.state.buffers.depth.setClear(saved.clearDepth)
      // Restore canvas state first; the target may have a different physical viewport/scissor.
      renderer.setViewport(saved.viewport)
      renderer.setScissor(saved.scissor)
      renderer.setScissorTest(saved.scissorTest)
      renderer.setRenderTarget(saved.target, saved.face, saved.mip)
      this.rendering = false
    }
  }

  dispose() {
    if (this.rendering) throw new Error('RasterPipeline cannot dispose while rendering.')
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.variants.values()) entry.dispose()
    for (const entry of this.diffuse.values()) entry.dispose()
    for (const target of [this.readBuffer, this.beauty, this.scratch, this.snapshot, ...this.peels, ...this.reductions]) target.dispose()
    this.ambientOcclusion.dispose()
    this.hidden.dispose()
    this.copy.dispose()
    this.reduce.dispose()
    this.aa.dispose()
    this.quad.dispose()
    this.output.dispose()
  }
}
