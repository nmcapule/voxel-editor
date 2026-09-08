import * as THREE from 'three'
import { CHUNK_SIZE, PADDED_SIZE, chunkCoords, type VoxelDocument } from '../../src/shared/voxel/document'
import type { ModelPreviewPlugin, ModelPreviewRenderer, PreviewFrame } from '../../src/shared/rendering/contracts'

/** Four bytes per exposed cell: 12-bit position, 8-bit palette index, 6 neighbor bits. */
export function packChunk(voxels: Uint8Array, transparent?: Uint8Array) {
  if (voxels.length !== PADDED_SIZE ** 3) throw new Error('Cube sprites requires a padded voxel chunk.')
  const packed = new Uint32Array(CHUNK_SIZE ** 3)
  const offsets = [-1, 1, -PADDED_SIZE, PADDED_SIZE, -(PADDED_SIZE ** 2), PADDED_SIZE ** 2]
  let count = 0
  for (let z = 0; z < CHUNK_SIZE; z++) for (let y = 0; y < CHUNK_SIZE; y++) for (let x = 0; x < CHUNK_SIZE; x++) {
    const i = x + 1 + (y + 1) * PADDED_SIZE + (z + 1) * PADDED_SIZE ** 2
    const color = voxels[i]
    if (!color) continue
    let neighbors = 0
    for (let face = 0; face < 6; face++) {
      const other = voxels[i + offsets[face]]
      if (other && (other === color || !transparent?.[other])) neighbors |= 1 << face
    }
    if (neighbors === 63) continue
    packed[count++] = x | y << 4 | z << 8 | color << 12 | neighbors << 20
  }
  return packed.slice(0, count)
}

const vertexShader = `
  attribute uint voxel;
  uniform vec2 extent;
  uniform vec2 pixelWorld;
  flat varying vec3 centerView;
  flat varying vec3 centerWorld;
  flat varying uint paletteIndex;
  flat varying uint neighbors;
  void main() {
    vec3 center = vec3(float(voxel & 15u), float((voxel >> 4u) & 15u), float((voxel >> 8u) & 15u)) + 0.5;
    paletteIndex = (voxel >> 12u) & 255u;
    neighbors = voxel >> 20u;
    centerView = (modelViewMatrix * vec4(center, 1.0)).xyz;
    centerWorld = (modelMatrix * vec4(center, 1.0)).xyz;
    gl_Position = projectionMatrix * vec4(centerView + vec3(position.xy * (extent + 2.0 * pixelWorld), 0.0), 1.0);
  }
`

const surfaceShader = `
  uniform sampler2D cubeImage;
  uniform vec2 extent;
  uniform mat3 viewBasis;
  uniform mat4 spriteProjection;
  uniform mat4 spriteProjectionInverse;
  uniform vec2 spriteSize;
  flat varying vec3 centerView;
  flat varying vec3 centerWorld;
  flat varying uint paletteIndex;
  flat varying uint neighbors;

  void cubeSurface(out vec3 worldPosition, out vec3 normal) {
    // Screen coordinates, rather than interpolated quad UVs, avoid subpixel
    // rasterization rounding changing the reconstructed cube planes.
    vec4 viewPixel = spriteProjectionInverse * vec4(gl_FragCoord.xy / spriteSize * 2.0 - 1.0, 0.0, 1.0);
    vec2 xy = viewPixel.xy / viewPixel.w - centerView.xy;
    vec4 sampleValue = texture2D(cubeImage, xy / extent + 0.5);
    normal = sampleValue.xyz;
    vec3 viewNormal = transpose(viewBasis) * normal;
    // The cached face defines an exact plane. Avoid quantizing depth to atlas texels.
    #ifdef SPRITE_BACK_FACES
      bool facing = viewNormal.z < -0.000001;
    #else
      bool facing = viewNormal.z > 0.000001;
    #endif
    float z = facing ? (0.5 - dot(viewNormal.xy, xy)) / viewNormal.z : sampleValue.w;
    vec3 local = viewBasis * vec3(xy, z);
    if (dot(normal, normal) < 0.5 || any(greaterThan(abs(local), vec3(0.500001)))) {
      // Only silhouette/face-boundary texels need an exact intersection. This removes
      // cracks between touching sprites even when a cube is magnified beyond its atlas.
      vec3 origin = viewBasis * vec3(xy, 2.0);
      vec3 ray = -viewBasis[2];
      vec3 safeRay = mix(vec3(0.0000001), ray, greaterThan(abs(ray), vec3(0.0000001)));
      vec3 a = (-0.5 - origin) / safeRay;
      vec3 b = (0.5 - origin) / safeRay;
      vec3 nearHit = min(a, b), farHit = max(a, b);
      float enter = max(nearHit.x, max(nearHit.y, nearHit.z));
      float exit = min(farHit.x, min(farHit.y, farHit.z));
      if (enter > exit) discard;
      #ifdef SPRITE_BACK_FACES
        normal = farHit.x <= farHit.y && farHit.x <= farHit.z ? vec3(sign(ray.x), 0.0, 0.0)
          : farHit.y <= farHit.z ? vec3(0.0, sign(ray.y), 0.0) : vec3(0.0, 0.0, sign(ray.z));
        z = 2.0 - exit;
      #else
        normal = nearHit.x >= nearHit.y && nearHit.x >= nearHit.z ? vec3(-sign(ray.x), 0.0, 0.0)
          : nearHit.y >= nearHit.z ? vec3(0.0, -sign(ray.y), 0.0) : vec3(0.0, 0.0, -sign(ray.z));
        z = 2.0 - enter;
      #endif
      local = viewBasis * vec3(xy, z);
    }
    #if defined(SPRITE_BACK_FACES) || defined(SPRITE_PBR)
      // Internal cell boundaries aren't model surfaces. Casting from them creates
      // false grid-shaped shadows on otherwise flat walls.
      uint face = normal.x < -0.5 ? 1u : normal.x > 0.5 ? 2u : normal.y < -0.5 ? 4u
        : normal.y > 0.5 ? 8u : normal.z < -0.5 ? 16u : 32u;
      if ((neighbors & face) != 0u) discard;
    #endif
    vec4 clip = spriteProjection * vec4(centerView + vec3(xy, z), 1.0);
    float depth = clip.z / clip.w * 0.5 + 0.5;
    if (depth < 0.0 || depth > 1.0) discard;
    gl_FragDepth = depth;
    worldPosition = centerWorld + local;
  }
`

/** Patch after the raster pipeline so peeling tests the hit depth, never the billboard. */
export function patchPhysicalShader(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = (shader.vertexShader.includes('invariant gl_Position;') ? 'invariant gl_Position;\n' : '') + vertexShader
  const expand = (source: string): string => source.replace(/#include <(\w+)>/g,
    (_, name: keyof typeof THREE.ShaderChunk) => expand(THREE.ShaderChunk[name]))
  let fragment = expand(shader.fragmentShader)
  // Fragment-local replacements, not writes to read-only interpolants. Includes are
  // expanded so normal maps, transmission and shadow helpers all see the same hit.
  const inputs = ['vViewPosition', 'vWorldPosition', 'vNormal', 'vUv', 'vFogDepth', 'vClipPosition', 'vPosition', 'vDirectionalShadowCoord', 'vPointShadowCoord', 'vSpotLightCoord']
  fragment = fragment.replace(/varying\s+(vec[234]|float)\s+(\w+)(\s*\[[^;]+\])?\s*;/g, (declaration, type, name, array = '') =>
    inputs.includes(name) || /^v\w*MapUv$/.test(name) ? `${type} ${name}${array};` : declaration)
  const uvPars = THREE.ShaderChunk.uv_pars_vertex.replace(/varying\s+vec2\s+\w+\s*;/g, '')
  // These two transforms already live in Three's fragment declarations.
    .replace(/uniform mat3 (transmissionMapTransform|thicknessMapTransform);/g, '')
    + '\n#ifdef USE_DISPLACEMENTMAP\nvec2 vDisplacementMapUv;\n#endif\n'
  const uv = THREE.ShaderChunk.uv_vertex.replace(/\b(?:\w+_UV|uv)\b/g, name => name === 'USE_UV' ? name : 'spriteUv')
  const init = `
    vec3 spritePoint, spriteNormal;
    cubeSurface(spritePoint, spriteNormal);
    vViewPosition = -(viewMatrix * vec4(spritePoint, 1.0)).xyz;
    #ifndef FLAT_SHADED
      vNormal = mat3(viewMatrix) * spriteNormal;
    #endif
    #ifdef USE_TRANSMISSION
      vWorldPosition = spritePoint;
    #endif
    vec3 chunkPoint = spritePoint - centerWorld + centerChunk;
    #ifdef USE_ALPHAHASH
      vPosition = chunkPoint;
    #endif
    #ifdef USE_FOG
      vFogDepth = vViewPosition.z;
    #endif
    #if NUM_CLIPPING_PLANES > 0
      vClipPosition = vViewPosition;
    #endif
    vec2 spriteUv = abs(spriteNormal.x) > 0.5 ? chunkPoint.yz : abs(spriteNormal.y) > 0.5 ? chunkPoint.zx : chunkPoint.xy;
    ${uv}
    #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
      vDirectionalShadowCoord[0] = spriteShadowMatrix * vec4(spritePoint + spriteNormal * directionalLightShadows[0].shadowNormalBias, 1.0);
    #endif
  `
  const marker = /gl_FragDepth\s*=\s*gl_FragCoord\.z\s*;\s*\/\/ voxel-fragment-depth/
  if (fragment.includes('rasterPreviousDepth') || fragment.includes('rasterSelectedDepth')) {
    if (!marker.test(fragment)) throw new Error('Cube sprites PBR requires the voxel-fragment-depth raster marker.')
    fragment = fragment.replace(marker, init)
  } else fragment = fragment.replace(/void main\s*\(\s*\)\s*\{/, match => match + init)
  shader.vertexShader = shader.vertexShader.replace('flat varying vec3 centerWorld;', 'flat varying vec3 centerWorld; flat varying vec3 centerChunk;')
    .replace('paletteIndex =', 'centerChunk = center;\n    paletteIndex =')
  shader.fragmentShader = `#define SPRITE_PBR\n${surfaceShader}\nflat varying vec3 centerChunk;\nuniform mat4 spriteShadowMatrix;\n${uvPars}\n` + fragment
}

class CubeBake {
  readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  })
  readonly uniforms = {
    cubeImage: { value: this.target.texture }, extent: { value: new THREE.Vector2() },
    viewBasis: { value: new THREE.Matrix3() }, spriteProjection: { value: new THREE.Matrix4() },
    spriteProjectionInverse: { value: new THREE.Matrix4() }, spriteSize: { value: new THREE.Vector2() }, pixelWorld: { value: new THREE.Vector2() },
  }
  private orientation?: THREE.Quaternion
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2, 2)
  private scene = new THREE.Scene()
  private cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.ShaderMaterial({
    toneMapped: false,
    vertexShader: `varying vec3 faceNormal; varying float surfaceDepth;
      void main() { faceNormal = normal; vec4 p = modelViewMatrix * vec4(position, 1.0);
        surfaceDepth = p.z; gl_Position = projectionMatrix * p; }`,
    fragmentShader: `varying vec3 faceNormal; varying float surfaceDepth;
      void main() { gl_FragColor = vec4(faceNormal, surfaceDepth); }`,
  }))
  bakes = 0

  constructor(side: THREE.Side = THREE.FrontSide) { this.cube.material.side = side; this.scene.add(this.cube) }

  prepare(renderer: THREE.WebGLRenderer, camera: THREE.OrthographicCamera, width: number, height: number) {
    camera.updateWorldMatrix(true, false)
    const orientation = camera.getWorldQuaternion(new THREE.Quaternion())
    const basis = this.uniforms.viewBasis.value.setFromMatrix4(camera.matrixWorld)
    const e = basis.elements
    this.uniforms.extent.value.set(Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]), Math.abs(e[3]) + Math.abs(e[4]) + Math.abs(e[5]))
    this.uniforms.spriteProjection.value.copy(camera.projectionMatrix)
    this.uniforms.spriteProjectionInverse.value.copy(camera.projectionMatrixInverse)
    this.uniforms.spriteSize.value.set(width, height)
    this.uniforms.pixelWorld.value.set((camera.right - camera.left) / camera.zoom / width, (camera.top - camera.bottom) / camera.zoom / height)
    const extent = this.uniforms.extent.value
    const pixels = Math.max(extent.x * width / (camera.right - camera.left), extent.y * height / (camera.top - camera.bottom)) * camera.zoom
    // ponytail: bound each RGBA16F atlas to 8 MiB; exact edge intersections handle larger magnification.
    const size = Math.max(this.target.width, Math.min(1024, Math.max(128, 2 ** Math.ceil(Math.log2(Math.max(1, pixels * 2))))))
    if (this.orientation && Math.abs(this.orientation.dot(orientation)) > 1 - 1e-12 && this.target.width === size) return false
    const saved = {
      target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
      viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()),
      scissorTest: renderer.getScissorTest(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear, shadows: renderer.shadowMap.enabled, xr: renderer.xr.enabled,
    }
    try {
      this.target.setSize(size, size)
      this.camera.quaternion.copy(orientation)
      this.camera.left = -extent.x / 2; this.camera.right = extent.x / 2
      this.camera.bottom = -extent.y / 2; this.camera.top = extent.y / 2
      this.camera.updateProjectionMatrix()
      renderer.shadowMap.enabled = false
      renderer.xr.enabled = false
      renderer.autoClear = true
      renderer.setScissorTest(false)
      renderer.setClearColor(0, 0)
      renderer.setRenderTarget(this.target)
      renderer.render(this.scene, this.camera)
      this.orientation = orientation
      this.bakes++
      return true
    } finally {
      renderer.autoClear = saved.autoClear; renderer.shadowMap.enabled = saved.shadows; renderer.xr.enabled = saved.xr
      renderer.setClearColor(saved.color, saved.alpha)
      renderer.setViewport(saved.viewport); renderer.setScissor(saved.scissor); renderer.setScissorTest(saved.scissorTest)
      renderer.setRenderTarget(saved.target, saved.face, saved.mip)
    }
  }

  dispose() { this.target.dispose(); this.cube.geometry.dispose(); this.cube.material.dispose() }
}

export class CubeSprites implements ModelPreviewRenderer {
  readonly root = new THREE.Group()
  readonly stats = { instances: 0, chunkUpdates: 0, viewBakes: 0, shadowBakes: 0, instanceBytes: 0 }
  private document: VoxelDocument
  private layerId?: number
  private chunks = new Map<number, THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>[]>()
  private pbr = false
  private transparent = new Uint8Array(256)
  private physical = new Map<number, { material: THREE.MeshPhysicalMaterial; source: THREE.MeshPhysicalMaterial; version: number }>()
  private dirty = new Set<number>()
  private viewBake = new CubeBake()
  // Match Three's back-face shadow casters: front-face depths self-shadow flat receivers under PCF.
  private shadowBake = new CubeBake(THREE.BackSide)
  private quad = new THREE.PlaneGeometry(1, 1)
  private colors = new Float32Array(256 * 4)
  private palette = new THREE.DataTexture(this.colors, 256, 1, THREE.RGBAFormat, THREE.FloatType)
  private material = new THREE.ShaderMaterial({
    lights: true, toneMapped: false, shadowSide: THREE.FrontSide,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights), ...this.viewBake.uniforms,
      palette: { value: this.palette }, keyDirection: { value: new THREE.Vector3() }, keyColor: { value: new THREE.Color() },
      ambient: { value: 1 }, spriteShadowMatrix: { value: new THREE.Matrix4() },
    },
    vertexShader,
    fragmentShader: `
      #include <common>
      #include <packing>
      #include <shadowmap_pars_fragment>
      ${surfaceShader}
      uniform sampler2D palette;
      uniform vec3 keyDirection;
      uniform vec3 keyColor;
      uniform float ambient;
      uniform mat4 spriteShadowMatrix;
      void main() {
        vec3 point, normal;
        cubeSurface(point, normal);
        float visibility = 1.0;
        #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
          DirectionalLightShadow shadow = directionalLightShadows[0];
          visibility = getShadow(directionalShadowMap[0], shadow.shadowMapSize, shadow.shadowIntensity,
            shadow.shadowBias, shadow.shadowRadius,
            spriteShadowMatrix * vec4(point + normal * max(0.005, shadow.shadowNormalBias), 1.0));
        #endif
        vec3 sky = mix(vec3(0.35, 0.38, 0.42), vec3(1.0), normal.y * 0.5 + 0.5) * ambient * 0.5;
        vec3 light = sky + keyColor * max(0.0, dot(normal, keyDirection)) * visibility / PI;
        gl_FragColor = vec4(texelFetch(palette, ivec2(int(paletteIndex), 0), 0).rgb * light, 1.0);
      }
    `,
  })
  private depthMaterial = new THREE.ShaderMaterial({
    defines: { SPRITE_BACK_FACES: 1 },
    toneMapped: false, uniforms: this.shadowBake.uniforms, vertexShader,
    fragmentShader: `${surfaceShader}
      void main() { vec3 point, normal; cubeSurface(point, normal); gl_FragColor = vec4(1.0); }`,
  })
  private disposed = false

  constructor(document: VoxelDocument) {
    this.document = document
    this.root.name = 'Cube sprites'
    this.setDocument(document)
  }

  setDocument(document: VoxelDocument) {
    if (this.disposed) throw new Error('Cube sprites is disposed.')
    for (const meshes of this.chunks.values()) for (const mesh of meshes) mesh.geometry.dispose()
    for (const entry of this.physical.values()) entry.material.dispose()
    this.physical.clear()
    this.chunks.clear(); this.root.clear(); this.dirty.clear()
    this.stats.instances = this.stats.instanceBytes = 0
    this.document = document
    this.markDirty(document.chunks.keys())
    this.updatePalette()
  }

  markDirty(ids: Iterable<number>) { for (const id of ids) this.dirty.add(id) }

  setLayerScope(layerId?: number) {
    if (this.layerId === layerId) return false
    this.layerId = layerId
    this.markDirty(this.document.chunks.keys())
    this.markDirty(this.chunks.keys())
    return true
  }

  updatePalette() {
    const color = new THREE.Color()
    this.document.palette.forEach((hex, index) => {
      color.setHex(hex)
      this.colors.set([color.r, color.g, color.b, 1], index * 4)
    })
    this.palette.needsUpdate = true
  }

  prepare({ renderer, camera, light, settings, width, height, materials, reducedQuality }: PreviewFrame) {
    if (this.disposed) throw new Error('Cube sprites is disposed.')
    if (!(camera instanceof THREE.OrthographicCamera)) throw new Error('Cube sprites requires an orthographic camera.')
    const pbr = settings.pbrMaterials
    if (pbr && !materials) throw new Error('Cube sprites PBR requires host palette materials in prepare().')
    let repack = this.pbr !== pbr
    this.pbr = pbr
    if (pbr) {
      for (let index = 1; index < 256; index++) {
        const source = materials![index]
        if (!source?.isMeshPhysicalMaterial) throw new Error(`Cube sprites PBR requires physical palette material ${index}.`)
        const transparent = Number(source.opacity < 1) | (Number(source.transmission > 0) << 1)
        if (this.transparent[index] !== transparent) repack = true
        this.transparent[index] = transparent
        // The host versions material edits, including environment bindings. Borrowed
        // textures keep image/UV-transform updates live without copying each frame.
        let entry = this.physical.get(index)
        if (entry?.source === source && entry.version === source.version) continue
        if (!entry) {
          entry = { material: source.clone(), source, version: source.version }
          this.physical.set(index, entry)
        } else { entry.material.copy(source); entry.source = source; entry.version = source.version }
        entry.material.visible = true
        entry.material.side = entry.material.shadowSide = THREE.FrontSide
        entry.material.forceSinglePass = true
        const uniforms = { ...this.viewBake.uniforms, spriteShadowMatrix: this.material.uniforms.spriteShadowMatrix }
        entry.material.onBeforeCompile = function(shader, webgl) {
          source.onBeforeCompile.call(this, shader, webgl)
          Object.assign(shader.uniforms, uniforms)
          patchPhysicalShader(shader)
        }
        entry.material.customProgramCacheKey = () => `cube-sprites-pbr-v1:voxel-fragment-depth:${source.customProgramCacheKey()}`
        entry.material.needsUpdate = true
        renderer.shadowMap.needsUpdate = true
      }
    }
    if (repack) { this.markDirty(this.document.chunks.keys()); this.markDirty(this.chunks.keys()) }
    if (this.dirty.size) renderer.shadowMap.needsUpdate = true
    // ponytail: pack dirty 16-cubed chunks on demand; move packing to a worker if activation stalls on highly exposed models.
    for (const id of this.dirty) {
      const previous = this.chunks.get(id)
      if (previous) {
        for (const mesh of previous) {
          this.stats.instances -= mesh.geometry.instanceCount
          mesh.geometry.dispose(); mesh.removeFromParent()
        }
        this.chunks.delete(id)
      }
      const packed = this.document.chunks.has(id)
        ? packChunk(this.document.paddedChunk(id, true, this.layerId === undefined ? undefined : [this.layerId]), pbr ? this.transparent : undefined) : new Uint32Array()
      this.stats.chunkUpdates++
      if (!packed.length) continue
      const batches = new Map<number, number[]>()
      for (const cell of packed) {
        const index = pbr ? cell >>> 12 & 255 : 0
        if (!batches.has(index)) batches.set(index, [])
        batches.get(index)!.push(cell)
      }
      const meshes: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>[] = []
      for (const [index, batch] of batches) {
        const geometry = new THREE.InstancedBufferGeometry()
        geometry.setIndex(this.quad.index!.clone())
        geometry.setAttribute('position', this.quad.getAttribute('position').clone())
        geometry.setAttribute('uv', this.quad.getAttribute('uv').clone())
        const cells = new THREE.InstancedBufferAttribute(new Uint32Array(batch), 1)
        cells.gpuType = THREE.IntType
        geometry.setAttribute('voxel', cells)
        geometry.instanceCount = batch.length
        geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE))
        geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())
        const mesh = new THREE.Mesh(geometry, pbr ? this.physical.get(index)!.material : this.material)
        mesh.userData.fullMaterial = mesh.material
        const chunk = chunkCoords(id)
        mesh.position.set(chunk.x * CHUNK_SIZE - this.document.dimensions.x / 2, chunk.y * CHUNK_SIZE, chunk.z * CHUNK_SIZE - this.document.dimensions.z / 2)
        mesh.receiveShadow = true
        mesh.castShadow = !pbr || !this.transparent[index]
        mesh.customDepthMaterial = this.depthMaterial
        meshes.push(mesh); this.root.add(mesh)
        this.stats.instances += batch.length
      }
      this.chunks.set(id, meshes)
    }
    this.dirty.clear()
    // Both shaders read the same voxel attribute; quality changes only the draw material.
    for (const meshes of this.chunks.values()) for (const mesh of meshes) {
      mesh.material = reducedQuality ? this.material : mesh.userData.fullMaterial
    }
    this.stats.instanceBytes = this.stats.instances * 4
    this.viewBake.prepare(renderer, camera, width, height)
    light.updateWorldMatrix(true, false); light.target.updateWorldMatrix(true, false)
    light.shadow.updateMatrices(light)
    if (settings.shadows && this.shadowBake.prepare(renderer, light.shadow.camera, light.shadow.mapSize.x, light.shadow.mapSize.y)) renderer.shadowMap.needsUpdate = true
    this.material.uniforms.keyDirection.value.setFromMatrixPosition(light.matrixWorld)
      .sub(new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld)).normalize()
    this.material.uniforms.keyColor.value.copy(light.color).multiplyScalar(light.intensity)
    this.material.uniforms.ambient.value = settings.ambient
    this.material.uniforms.spriteShadowMatrix.value.copy(light.shadow.matrix)
    this.stats.viewBakes = this.viewBake.bakes
    this.stats.shadowBakes = this.shadowBake.bakes
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const meshes of this.chunks.values()) for (const mesh of meshes) mesh.geometry.dispose()
    for (const entry of this.physical.values()) entry.material.dispose()
    this.physical.clear()
    this.chunks.clear(); this.dirty.clear(); this.root.clear()
    this.viewBake.dispose(); this.shadowBake.dispose(); this.quad.dispose()
    this.material.dispose(); this.depthMaterial.dispose(); this.palette.dispose()
  }
}

export default { id: 'cube-sprites', label: 'Cube sprites', create: document => new CubeSprites(document) } satisfies ModelPreviewPlugin
