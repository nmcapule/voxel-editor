import { expect, spyOn, test } from 'bun:test'
import * as THREE from 'three'
import { chunkId, PADDED_SIZE, VoxelDocument } from '../../src/shared/voxel/document'
import { CubeSprites, packChunk, patchPhysicalShader } from './index'
import { DEFAULT_SETTINGS } from '../../src/shared/rendering/settings'
import type { PreviewFrame } from '../../src/shared/rendering/contracts'

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
  const frame: PreviewFrame = { renderer: { shadowMap: {} } as THREE.WebGLRenderer, camera: new THREE.OrthographicCamera(),
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
  const retained = meshes.map(mesh => ({ material: mesh.material, geometry: mesh.geometry, voxel: mesh.geometry.getAttribute('voxel') }))
  const stats = { ...sprites.stats }, paddedChunk = spyOn(model, 'paddedChunk')
  let geometryDisposals = 0, materialDisposals = 0
  for (const entry of retained) {
    entry.geometry.addEventListener('dispose', () => geometryDisposals++)
    entry.material.addEventListener('dispose', () => materialDisposals++)
  }
  const cheap = Reflect.get(sprites, 'material') as THREE.ShaderMaterial
  expect(cheap.transparent).toBe(false)
  expect(cheap.depthWrite).toBe(true)
  for (const reducedQuality of [true, false, true, undefined]) {
    frame.reducedQuality = reducedQuality
    sprites.prepare(frame)
    expect(sprites.stats).toEqual(stats)
    expect(paddedChunk).not.toHaveBeenCalled()
    expect(geometryDisposals).toBe(0)
    expect(materialDisposals).toBe(0)
    expect(material.version).toBe(version)
    expect(meshes.map(mesh => mesh.castShadow)).toEqual([true, false])
    meshes.forEach((mesh, i) => {
      expect(sprites.root.children[i]).toBe(mesh)
      expect(mesh.geometry).toBe(retained[i].geometry)
      expect(mesh.geometry.getAttribute('voxel')).toBe(retained[i].voxel)
      expect<THREE.Material>(mesh.material).toBe(reducedQuality ? cheap : retained[i].material)
    })
  }
  paddedChunk.mockRestore()
  materials[7].roughness = 0.23; materials[7].ior = 1.8
  materials[7].needsUpdate = true
  frame.reducedQuality = true
  sprites.prepare(frame)
  expect(material.roughness).toBe(0.23)
  expect(material.ior).toBe(1.8)
  expect(material.map).toBe(map)
  expect(material.envMap).toBe(map)
  expect<THREE.Material>(meshes[0].material).toBe(cheap)
  frame.reducedQuality = undefined
  sprites.prepare(frame)
  expect(meshes[0].material).toBe(material)
  expect(meshes[0].geometry).toBe(geometry)
  expect(sprites.stats.chunkUpdates).toBe(stats.chunkUpdates)
  frame.reducedQuality = true
  materials[7].opacity = 0.5
  materials[7].needsUpdate = true
  sprites.prepare(frame)
  expect(sprites.root.children[0]).not.toBe(meshes[0])
  expect((sprites.root.children[0] as THREE.Mesh).castShadow).toBe(false)
  expect((sprites.root.children[0] as THREE.Mesh).material).toBe(cheap)
  const alphaMesh = sprites.root.children[0]
  materials[7].transmission = 0.9
  materials[7].needsUpdate = true
  sprites.prepare(frame)
  expect(sprites.root.children[0]).not.toBe(alphaMesh)
  frame.reducedQuality = undefined
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

test('cheap initial frames and dirty edits retain physical packing until the actual PBR preference changes', () => {
  const model = new VoxelDocument()
  model.setVoxel(1, 1, 1, 7); model.setVoxel(2, 1, 1, 12); model.setVoxel(20, 1, 1, 7)
  const sprites = new CubeSprites(model)
  Reflect.get(sprites, 'viewBake').prepare = () => false
  Reflect.get(sprites, 'shadowBake').prepare = () => { throw new Error('Cheap frames must skip the shadow bake') }
  const materials = model.materials.map(() => new THREE.MeshPhysicalMaterial())
  materials[12].transmission = 0.8
  const frame: PreviewFrame = { renderer: { shadowMap: {} } as THREE.WebGLRenderer, camera: new THREE.OrthographicCamera(),
    light: new THREE.DirectionalLight(), settings: { ...DEFAULT_SETTINGS, shadows: false }, materials,
    width: 32, height: 32, reducedQuality: true }
  const cheap = Reflect.get(sprites, 'material') as THREE.ShaderMaterial
  sprites.prepare(frame)
  const initial = sprites.root.children.slice() as THREE.Mesh<THREE.InstancedBufferGeometry>[]
  expect(initial).toHaveLength(3)
  expect(initial.every(mesh => mesh.material === cheap)).toBe(true)
  expect(initial.map(mesh => mesh.castShadow)).toEqual([true, false, true])
  // The opaque voxel's face against glass must remain exposed, even on a cheap frame.
  expect(initial[0].geometry.getAttribute('voxel').array[0] >>> 20 & 2).toBe(0)
  const updates = sprites.stats.chunkUpdates, untouched = initial[2]
  let disposed = 0
  initial[0].geometry.addEventListener('dispose', () => disposed++)
  model.setVoxel(3, 1, 1, 7)
  sprites.markDirty([0])
  sprites.prepare(frame)
  expect(sprites.stats.chunkUpdates).toBe(updates + 1)
  expect(sprites.stats.instances).toBe(4)
  expect(disposed).toBe(1)
  expect(sprites.root.children).toContain(untouched)
  const edited = sprites.root.children.slice() as THREE.Mesh<THREE.InstancedBufferGeometry>[]
  expect(edited.every(mesh => mesh.material === cheap)).toBe(true)
  frame.reducedQuality = false
  sprites.prepare(frame)
  expect(sprites.stats.chunkUpdates).toBe(updates + 1)
  edited.forEach(mesh => {
    const index = mesh.geometry.getAttribute('voxel').array[0] >>> 12 & 255
    expect(mesh.material).toBe(Reflect.get(sprites, 'physical').get(index).material)
    expect(mesh.castShadow).toBe(index !== 12)
  })
  frame.reducedQuality = true
  frame.settings.pbrMaterials = false
  sprites.prepare(frame)
  expect(sprites.stats.chunkUpdates).toBe(updates + 3)
  expect(sprites.root.children).toHaveLength(2)
  expect((sprites.root.children as THREE.Mesh[]).every(mesh => mesh.material === cheap && mesh.castShadow)).toBe(true)
  const opaque = sprites.root.children.slice()
  frame.reducedQuality = undefined
  sprites.prepare(frame)
  expect(sprites.root.children).toEqual(opaque)
  expect(sprites.stats.chunkUpdates).toBe(updates + 3)
  frame.reducedQuality = true
  frame.settings.pbrMaterials = true
  sprites.prepare(frame)
  expect(sprites.stats.chunkUpdates).toBe(updates + 5)
  expect(sprites.root.children).toHaveLength(3)
  expect((sprites.root.children as THREE.Mesh[]).every(mesh => mesh.material === cheap)).toBe(true)
  frame.reducedQuality = undefined
  sprites.prepare(frame)
  expect(sprites.stats.chunkUpdates).toBe(updates + 5)
  expect((sprites.root.children as THREE.Mesh[]).every(mesh => mesh.material instanceof THREE.MeshPhysicalMaterial)).toBe(true)
  sprites.dispose()
  for (const material of materials) material.dispose()
})
