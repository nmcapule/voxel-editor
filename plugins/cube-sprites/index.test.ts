import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { chunkId, PADDED_SIZE, VoxelDocument } from '../../src/shared/voxel/document'
import { CubeSprites, packChunk, patchPhysicalShader } from './index'
import { DEFAULT_SETTINGS } from '../../src/shared/rendering/settings'

test('sprite cells preserve palette indices and visible layers, and cull enclosed cells across chunk seams', () => {
  const document = new VoxelDocument({ x: 32, y: 16, z: 16 })
  document.palette[7] = 0
  document.setVoxel(15, 5, 5, 7)
  let cells = packChunk(document.paddedChunk(chunkId(0, 0, 0), true))
  const payloads = () => [...packChunk(document.paddedChunk(0, true))].map(cell => cell & 0xfffff)
  expect([...cells]).toEqual([15 | 5 << 4 | 5 << 8 | 7 << 12])
  for (const [x, y, z] of [[14, 5, 5], [16, 5, 5], [15, 4, 5], [15, 6, 5], [15, 5, 4], [15, 5, 6]]) document.setVoxel(x, y, z, 3)
  expect(payloads()).not.toContain(cells[0])
  document.setVoxel(16, 5, 5, 0)
  expect(payloads()).toContain(cells[0])
  expect([...packChunk(document.paddedChunk(0, true))].find(cell => (cell & 0xfffff) === cells[0])! >>> 20).toBe(61)
  document.activeLayer.visible = false
  expect(packChunk(document.paddedChunk(0, true))).toHaveLength(0)
  document.activeLayer.visible = true
  const layer = document.createLayer()
  document.setVoxel(15, 5, 5, 12)
  expect(payloads()).toContain(15 | 5 << 4 | 5 << 8 | 12 << 12)
  layer.visible = false
  expect(payloads()).toContain(cells[0])
  expect(packChunk(new Uint8Array(PADDED_SIZE ** 3))).toHaveLength(0)
  expect(() => packChunk(new Uint8Array(1))).toThrow('padded')
  const sprites = new CubeSprites(document)
  sprites.dispose(); sprites.dispose()
  expect(() => sprites.setDocument(document)).toThrow('disposed')
})

test('PBR suppression matches mesher at same/different transparent interfaces and seams', () => {
  const model = new VoxelDocument({ x: 32, y: 16, z: 16 })
  const transparent = new Uint8Array(256)
  transparent[7] = transparent[12] = 1
  model.setVoxel(15, 5, 5, 7)
  for (const other of [0, 3, 7, 12]) {
    model.setVoxel(16, 5, 5, other)
    const cell = packChunk(model.paddedChunk(0), transparent)[0]
    expect(Boolean(cell >>> 20 & 2)).toBe(other === 3 || other === 7)
  }
})

test('physical patch initializes true depth before layered rejection and never assigns fragment varyings', () => {
  for (const layered of [false, true]) {
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} } as THREE.WebGLProgramParametersWithUniforms
    if (layered) shader.fragmentShader = shader.fragmentShader.replace('void main() {', `void main() {
      gl_FragDepth = gl_FragCoord.z;
      // voxel-fragment-depth
      if (gl_FragDepth > rasterPreviousDepth) discard;`)
    patchPhysicalShader(shader)
    expect(shader.fragmentShader).not.toContain('gl_FragDepth = gl_FragCoord.z;')
    expect(shader.fragmentShader).not.toMatch(/varying vec\d v(?:Normal|ViewPosition|WorldPosition|\w*MapUv)\s*;/)
    expect(shader.fragmentShader).toContain('normalMapTransform * vec3( spriteUv')
    expect(shader.fragmentShader).toContain('getTangentFrame( - vViewPosition')
    if (layered) expect(shader.fragmentShader.indexOf('cubeSurface(spritePoint')).toBeLessThan(shader.fragmentShader.indexOf('if (gl_FragDepth > rasterPreviousDepth)'))
  }
  expect(() => patchPhysicalShader({ vertexShader: '', fragmentShader: 'void main() { gl_FragDepth = gl_FragCoord.z; if (gl_FragDepth > rasterPreviousDepth) discard; }', uniforms: {} } as THREE.WebGLProgramParametersWithUniforms)).toThrow('marker')
})

test('PBR batches, toggles, live material edits and borrowed texture ownership', () => {
  const model = new VoxelDocument()
  model.setVoxel(1, 1, 1, 7); model.setVoxel(2, 1, 1, 12)
  const sprites = new CubeSprites(model)
  for (const key of ['viewBake', 'shadowBake']) Reflect.get(sprites, key).prepare = () => false
  const materials = model.materials.map(() => new THREE.MeshPhysicalMaterial())
  const map = new THREE.Texture()
  let disposed = false
  map.addEventListener('dispose', () => { disposed = true })
  materials[7].map = materials[7].envMap = map
  materials[7].visible = false
  materials[12].transmission = 0.8
  const frame = { renderer: { shadowMap: {} } as THREE.WebGLRenderer, camera: new THREE.OrthographicCamera(),
    light: new THREE.DirectionalLight(), settings: { ...DEFAULT_SETTINGS, shadows: false }, materials, width: 32, height: 32 }
  expect(frame.settings.pbrMaterials).toBe(true)
  sprites.prepare(frame)
  const meshes = sprites.root.children.slice() as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshPhysicalMaterial>[]
  expect(meshes).toHaveLength(2)
  expect(meshes.map(mesh => mesh.castShadow)).toEqual([true, false])
  expect(meshes[0].material).not.toBe(materials[7])
  expect(meshes[0].material.map).toBe(map)
  expect(meshes[0].material.envMap).toBe(map)
  expect(meshes[0].material.visible).toBe(true)
  const geometry = meshes[0].geometry, material = meshes[0].material, version = material.version
  sprites.prepare(frame)
  expect(material.version).toBe(version)
  materials[7].roughness = 0.23; materials[7].ior = 1.8
  materials[7].needsUpdate = true
  sprites.prepare(frame)
  expect(material.roughness).toBe(0.23)
  expect(material.ior).toBe(1.8)
  expect(meshes[0].geometry).toBe(geometry)
  materials[7].opacity = 0.5
  materials[7].needsUpdate = true
  sprites.prepare(frame)
  expect(sprites.root.children[0]).not.toBe(meshes[0])
  expect((sprites.root.children[0] as THREE.Mesh).castShadow).toBe(false)
  const alphaMesh = sprites.root.children[0]
  materials[7].transmission = 0.9
  materials[7].needsUpdate = true
  sprites.prepare(frame)
  expect(sprites.root.children[0]).not.toBe(alphaMesh)
  frame.settings.pbrMaterials = false
  sprites.prepare(frame)
  expect(sprites.root.children).toHaveLength(1)
  expect((sprites.root.children[0] as THREE.Mesh).material).toBeInstanceOf(THREE.ShaderMaterial)
  expect(materials[7].map).toBe(map)
  expect(materials[7].envMap).toBe(map)
  expect(materials[7].opacity).toBe(0.5)
  expect(materials[7].transmission).toBe(0.9)
  frame.settings.pbrMaterials = true
  sprites.prepare(frame)
  expect(sprites.root.children).toHaveLength(2)
  expect((sprites.root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>).material.map).toBe(map)
  sprites.dispose()
  expect(disposed).toBe(false)
  for (const material of materials) material.dispose()
  map.dispose()
})
