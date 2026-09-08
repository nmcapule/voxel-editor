// Open tests/transparency.html and import('/plugins/cube-sprites/browser-checks.ts').
import * as THREE from 'three'
import plugin, { CubeSprites } from './index'
import { VoxelDocument, dirtyChunks } from '../../src/shared/voxel/document'
import { DEFAULT_SETTINGS } from '../../src/shared/rendering/settings'
import { VoxelRenderer, type RendererCallbacks } from '../../src/editors/model/renderer'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function pixels(renderer: VoxelRenderer) {
  const capture = await renderer.capture()
  const bitmap = await createImageBitmap(capture.blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0); bitmap.close()
  return context.getImageData(0, 0, canvas.width, canvas.height).data
}

function difference(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

export function runCubeSpriteDepthChecks() {
  const renderer = new THREE.WebGLRenderer()
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join('\n'))
  }
  const target = new THREE.WebGLRenderTarget(192, 192, { type: THREE.FloatType })
  const model = new VoxelDocument({ x: 32, y: 16, z: 32 })
  for (const [x, y, z] of [[15, 3, 15], [16, 3, 15], [16, 4, 15], [16, 4, 16], [14, 3, 16], [14, 5, 16], [17, 2, 14]]) model.setVoxel(x, y, z, 3)
  const sprites = new CubeSprites(model)
  const spriteMaterial = Reflect.get(sprites, 'material') as THREE.ShaderMaterial
  spriteMaterial.fragmentShader = spriteMaterial.fragmentShader.replace(
    'gl_FragColor = vec4(texelFetch(palette, ivec2(int(paletteIndex), 0), 0).rgb * light, 1.0);',
    'gl_FragColor = vec4(normal * 0.5 + 0.5, gl_FragDepth);')
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.ShaderMaterial({
    vertexShader: `varying vec3 faceNormal; void main() { faceNormal = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 faceNormal; void main() { gl_FragColor = vec4(faceNormal * 0.5 + 0.5, gl_FragCoord.z); }`,
  })
  const reference = new THREE.Scene(), scene = new THREE.Scene(), light = new THREE.DirectionalLight()
  scene.add(sprites.root, light, light.target)
  model.forEachVisibleVoxel((x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x - 15.5, y + 0.5, z - 15.5)
    reference.add(mesh)
  })
  const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 40)
  const actual = new Float32Array(192 * 192 * 4), expected = new Float32Array(actual.length)
  const results: object[] = []
  try {
    renderer.setClearColor(0, 1)
    for (const direction of [[1, 1, 1], [-1, 0.3, 1], [-1, 1, -1], [1, -0.4, -1], [0, 0, 1], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0.03, 1, -1]]) {
      camera.position.set(...direction as [number, number, number]).normalize().multiplyScalar(15).add(new THREE.Vector3(0, 4, 0))
      camera.lookAt(0, 4, 0)
      sprites.prepare({ renderer, camera, light, settings: { ...DEFAULT_SETTINGS, shadows: false }, width: 192, height: 192 })
      renderer.setRenderTarget(target); renderer.render(scene, camera)
      renderer.readRenderTargetPixels(target, 0, 0, 192, 192, actual)
      renderer.render(reference, camera)
      renderer.readRenderTargetPixels(target, 0, 0, 192, 192, expected)
      let mismatches = 0, maxDepthError = 0, normalMismatches = 0, maxRayDepthError = 0
      const ray = new THREE.Raycaster()
      for (let i = 0; i < actual.length; i += 4) {
        const a = actual[i + 3] < 0.999, b = expected[i + 3] < 0.999
        if (a !== b) mismatches++
        else if (a) {
          const error = Math.abs(actual[i + 3] - expected[i + 3])
          maxDepthError = Math.max(maxDepthError, error)
          if (error > 0.000002) {
            const pixel = i / 4
            ray.setFromCamera(new THREE.Vector2(((pixel % 192) + 0.5) / 192 * 2 - 1, (Math.floor(pixel / 192) + 0.5) / 192 * 2 - 1), camera)
            const hit = ray.intersectObjects(reference.children)[0]
            check(hit, 'A reconstructed cube surface must intersect real geometry')
            maxRayDepthError = Math.max(maxRayDepthError, Math.abs(actual[i + 3] - (hit.point.project(camera).z * 0.5 + 0.5)))
          }
          if (Math.max(Math.abs(actual[i] - expected[i]), Math.abs(actual[i + 1] - expected[i + 1]), Math.abs(actual[i + 2] - expected[i + 2])) > 0.01) normalMismatches++
        }
      }
      // Software rasterizers round triangle vertices to subpixels; verify differing
      // depths against exact ray/geometry intersections, not that rounding error.
      check(mismatches <= 12 && normalMismatches <= 12 && maxRayDepthError < 0.000002,
        `Cube depth differs from real geometry: ${JSON.stringify({ direction, mismatches, normalMismatches, maxDepthError, maxRayDepthError })}`)
      results.push({ direction, mismatches, normalMismatches, maxDepthError, maxRayDepthError })
    }
    return results
  } finally { sprites.dispose(); target.dispose(); geometry.dispose(); material.dispose(); renderer.dispose() }
}

export async function runCubeSpriteBenchmark() {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;width:256px;height:256px'
  document.body.append(host)
  const callbacks = new Proxy({}, { get: () => () => {} }) as RendererCallbacks
  const settings = { ...DEFAULT_SETTINGS, pathTracing: false, ambientOcclusion: false, shadows: false, grid: false }
  const renderer = new VoxelRenderer(host, new VoxelDocument(), settings, callbacks, plugin)
  const results: object[] = []
  try {
    for (const shape of ['sparse', 'solid', 'checkerboard']) {
      const model = new VoxelDocument()
      for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
        if (shape === 'sparse' ? (x * 17 + y * 7 + z * 3) % 37 === 0 : shape === 'solid' || (x + y + z) % 2 === 0) model.setVoxel(x, y, z, 3)
      }
      renderer.setRenderMode(false); renderer.setDocument(model); await renderer.whenMeshIdle()
      renderer.setRenderMode(true)
      for (const previewRenderer of ['standard', 'cube-sprites'] as const) {
        renderer.setSettings({ ...settings, previewRenderer })
        renderer.setView({ position: { x: 70, y: 80, z: 70 }, target: { x: 0, y: 16, z: 0 }, orthographicSpan: 60, zoom: 1 })
        await pixels(renderer)
        for (const orbit of [false, true]) {
          const times: number[] = []
          for (let i = 0; i < 10; i++) {
            if (orbit) { renderer.viewport.camera.position.set(80 * Math.cos(i * 0.12), 70, 80 * Math.sin(i * 0.12)); renderer.viewport.camera.lookAt(0, 16, 0) }
            const started = performance.now()
            Reflect.get(renderer.viewport, 'renderRaster').call(renderer.viewport)
            renderer.viewport.renderer.getContext().finish()
            if (i > 2) times.push(performance.now() - started)
          }
          times.sort((a, b) => a - b)
          results.push({ shape, voxels: model.voxelCount, renderer: previewRenderer, orbit, medianMs: times[Math.floor(times.length / 2)],
            ...(previewRenderer === 'cube-sprites' ? { instances: (Reflect.get(renderer, 'preview') as CubeSprites).stats.instances } : {}) })
        }
      }
    }
    return results
  } finally { renderer.dispose(); host.remove() }
}

export async function runCubeSpriteChecks() {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;width:320px;height:320px'
  document.body.append(host)
  const errors: string[] = []
  const callbacks = new Proxy({ onError: (message: string) => errors.push(message) }, {
    get: (target, key) => target[key as keyof typeof target] ?? (() => {}),
  }) as unknown as RendererCallbacks
  const documentModel = new VoxelDocument({ x: 32, y: 16, z: 32 })
  for (let x = 11; x < 21; x++) for (let z = 11; z < 21; z++) documentModel.setVoxel(x, 0, z, 3)
  for (let y = 1; y < 6; y++) for (let x = 14; x < 17; x++) documentModel.setVoxel(x, y, 15, 7)
  const settings = { ...DEFAULT_SETTINGS, previewRenderer: 'cube-sprites' as const, projection: 'perspective' as const,
    ambientOcclusion: false, shadows: false, grid: false, lightAzimuth: 35 }
  const renderer = new VoxelRenderer(host, documentModel, settings, callbacks, plugin)
  const viewport = renderer.viewport
  viewport.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join('\n'))
  }
  try {
    check(viewport.camera instanceof THREE.OrthographicCamera, 'Imported perspective setting must become orthographic')
    renderer.setView({ position: { x: 16, y: 14, z: 20 }, target: { x: 0, y: 2, z: 0 }, orthographicSpan: 17, zoom: 1 })
    renderer.setRenderMode(true)
    const base = await pixels(renderer)
    const sprites = Reflect.get(renderer, 'preview') as CubeSprites
    check(sprites?.stats.instances > 100, 'Preview must contain composed voxel instances')
    check(difference(base, new Uint8Array(base.length).fill(base[0])) > 1, 'Preview must not be blank')
    check(!Reflect.get(viewport, 'pathTracingEnabled').call(viewport), 'Sprite preview must never enter progressive tracing')
    check((Reflect.get(renderer, 'materials') as THREE.Material[]).every(material => !material.visible) && sprites.root.visible, 'Only sprites contribute to voxel beauty/shadows')
    const initial = { ...sprites.stats }
    renderer.setView({ position: { x: 17, y: 14, z: 20 }, target: { x: 1, y: 2, z: 0 } })
    await pixels(renderer)
    check(sprites.stats.viewBakes === initial.viewBakes && sprites.stats.chunkUpdates === initial.chunkUpdates, 'Pan must not rebake or rebuild instances')
    renderer.setView({ position: { x: -16, y: 14, z: 20 }, target: { x: 0, y: 2, z: 0 } })
    await pixels(renderer)
    check(sprites.stats.viewBakes === initial.viewBakes + 1 && sprites.stats.chunkUpdates === initial.chunkUpdates, 'Orbit rebakes once without rebuilding instances')
    const rotated = await pixels(renderer)
    documentModel.palette[7] = 0x00ff00; renderer.updatePalette()
    const recolored = await pixels(renderer)
    check(difference(rotated, recolored) > 0.5 && sprites.stats.chunkUpdates === initial.chunkUpdates, 'Palette changes must update only colors')
    renderer.setSettings({ ...viewport.settings, ambientOcclusion: true })
    const ao = await pixels(renderer)
    check(difference(recolored, ao) > 0.02, 'AO must affect sprite surface depth')
    renderer.setSettings({ ...viewport.settings, ambientOcclusion: false, shadows: true })
    const shadows = await pixels(renderer)
    check(difference(recolored, shadows) > 0.02 && sprites.stats.shadowBakes === 1, 'Light-facing sprite depth must produce shadows')
    const shadowBakes = sprites.stats.shadowBakes
    renderer.setSettings({ ...viewport.settings, lightAzimuth: -55 })
    await pixels(renderer)
    check(sprites.stats.shadowBakes === shadowBakes + 1, 'Light rotation invalidates the light-facing bake')
    renderer.setSettings({ ...viewport.settings, lightAzimuth: 35, shadows: false })
    check(difference(await pixels(renderer), recolored) < 0.01, 'Disabling shadows restores unshadowed pixels')
    let flatInteriorDifference = 0
    for (const wall of [false, true]) {
      const flat = new VoxelDocument({ x: 32, y: 16, z: 32 })
      for (let x = 11; x < 21; x++) for (let t = 0; t < 10; t++) flat.setVoxel(x, wall ? t : 0, wall ? 16 : t + 11, 3)
      renderer.setDocument(flat)
      renderer.setSettings({ ...viewport.settings, shadows: false })
      const unshadowedPlane = await pixels(renderer)
      renderer.setSettings({ ...viewport.settings, shadows: true })
      const shadowedPlane = await pixels(renderer)
      const { width, height } = viewport.renderer.domElement
      const ray = new THREE.Raycaster(), point = new THREE.Vector3(), ndc = new THREE.Vector2()
      const plane = new THREE.Plane(wall ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0), -1)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        ray.setFromCamera(ndc.set((x + 0.5) / width * 2 - 1, 1 - (y + 0.5) / height * 2), viewport.camera)
        if (!ray.ray.intersectPlane(plane, point) || Math.abs(point.x) > 3 || (wall ? point.y < 2 || point.y > 8 : Math.abs(point.z) > 3)) continue
        const i = (y * width + x) * 4
        for (let c = 0; c < 3; c++) flatInteriorDifference = Math.max(flatInteriorDifference, Math.abs(unshadowedPlane[i + c] - shadowedPlane[i + c]))
      }
    }
    check(flatInteriorDifference <= 1, `Flat receivers must not acquire self-shadow speckling: ${flatInteriorDifference}`)
    renderer.setSettings({ ...viewport.settings, shadows: false })
    renderer.setDocument(documentModel)
    renderer.setView({ position: { x: -16, y: 14, z: 20 }, target: { x: 0, y: 2, z: 0 }, orthographicSpan: 17, zoom: 1 })
    documentModel.setVoxel(15, 5, 15, 0)
    renderer.markDirty(dirtyChunks(documentModel, [0]))
    const edited = await pixels(renderer)
    check(difference(edited, recolored) > 0 && sprites.stats.chunkUpdates > initial.chunkUpdates, 'Immediate capture includes voxel edits')
    const beforeInspection = await pixels(renderer)
    const images = await renderer.inspect(['iso-front-left', 'iso-back-right'])
    check(images.length === 2 && images.every(image => image.blob.size > 1000), 'Independent inspection cameras must render')
    check(difference(beforeInspection, await pixels(renderer)) < 0.01, 'Inspection must not leave a stale view bake')
    renderer.setRenderMode(false)
    check(Reflect.get(renderer, 'model').visible && sprites.root.visible, 'Edit mode keeps sprites and the helper tree active')
    renderer.setRenderMode(true)
    await pixels(renderer)
    renderer.setSettings({ ...viewport.settings, previewRenderer: 'standard', pathTracing: false, projection: 'perspective' })
    await pixels(renderer)
    check(viewport.camera instanceof THREE.PerspectiveCamera && !sprites.root.visible, 'Standard renderer restores perspective support')
    renderer.setSettings({ ...viewport.settings, previewRenderer: 'cube-sprites', pathTracing: true })
    await pixels(renderer)
    const extension = viewport.renderer.getContext().getExtension('WEBGL_lose_context')
    check(extension, 'Context loss extension required for recovery check')
    extension.loseContext()
    await new Promise(resolve => setTimeout(resolve, 100))
    check(!Reflect.get(renderer, 'preview'), 'Context loss releases plugin GPU resources')
    const restored = new Promise<void>(resolve => viewport.renderer.domElement.addEventListener('webglcontextrestored', () => resolve(), { once: true }))
    extension.restoreContext()
    await restored
    await pixels(renderer)
    check(Reflect.get(renderer, 'preview') !== sprites, 'Context recovery creates fresh bakes and instance resources')
    check(errors.length === 0, errors.join('\n'))
    return { ...initial, aoDifference: difference(recolored, ao), shadowDifference: difference(recolored, shadows),
      flatInteriorDifference,
      captures: true, inspection: true, recovery: true, errors }
  } finally { renderer.dispose(); host.remove() }
}

export async function runCubeSpriteEditingChecks() {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;width:320px;height:320px'
  document.body.append(host)
  const model = new VoxelDocument({ x: 32, y: 16, z: 16 }), active = model.activeLayerId
  model.setVoxel(15, 2, 7, 7); model.setVoxel(16, 2, 7, 7)
  const context = model.createLayer()
  for (const [x, y, z] of [[15, 2, 7], [14, 2, 7], [16, 2, 7], [15, 1, 7], [15, 3, 7], [15, 2, 6], [15, 2, 8], [4, 1, 3]]) model.setVoxel(x, y, z, 12)
  model.setActiveLayer(active)
  const errors: string[] = []
  const callbacks = new Proxy({ onError: (message: string) => errors.push(message) }, {
    get: (target, key) => target[key as keyof typeof target] ?? (() => {}),
  }) as unknown as RendererCallbacks
  const renderer = new VoxelRenderer(host, model, { ...DEFAULT_SETTINGS, previewRenderer: 'cube-sprites',
    grid: false, ambientOcclusion: false, shadows: false }, callbacks, plugin)
  const viewport = renderer.viewport
  const presented = async () => {
    await renderer.whenMeshIdle()
    await new Promise(requestAnimationFrame)
    check(!Reflect.get(viewport, 'presentationDirty') && Reflect.get(viewport, 'rasterFrame') === undefined,
      'Editing changes must present through RAF without capture or an explicit redraw')
  }
  const physical = () => Reflect.get(renderer, 'materials') as THREE.Material[]
  try {
    renderer.setView({ position: { x: 0, y: 20, z: 0 }, target: { x: 0, y: 2, z: 0 }, up: { x: 0, y: 0, z: -1 }, orthographicSpan: 18, zoom: 1 })
    await presented()
    const sprites = Reflect.get(renderer, 'preview') as CubeSprites
    const instanceCount = () => sprites.stats.instances
    check(!viewport.renderMode && sprites.root.visible && instanceCount() === 2, 'Editing must draw active sprites even with no selection')
    check(physical().every(material => !material.visible), 'Physical voxel materials must not duplicate sprites')
    const instances: number[] = []
    sprites.root.traverse(object => { if (object instanceof THREE.Mesh) instances.push(...object.geometry.getAttribute('voxel').array) })
    check(instances.every(cell => (cell >>> 12 & 255) === 7), 'Overlapping/surrounding context must not replace active colors or enclose active cells')
    const rect = viewport.renderer.domElement.getBoundingClientRect()
    const p = new THREE.Vector3(-0.5, 2.5, -0.5).project(viewport.camera)
    const hit = Reflect.get(renderer, 'targetAt').call(renderer, { clientX: rect.left + (p.x + 1) * rect.width / 2, clientY: rect.top + (1 - p.y) * rect.height / 2 })
    check(hit?.color === 7 && hit.cell.y === 2, 'Picking must pass through context roofs to active sprites')
    const isolated = await pixels(renderer)
    const updates = sprites.stats.chunkUpdates
    renderer.applySelection({ cells: [{ x: 15, y: 2, z: 7 }], count: 1 }, false)
    model.palette[7] = 0x00ff00; renderer.updatePalette()
    await presented()
    check(sprites.stats.chunkUpdates === updates && Reflect.get(renderer, 'selectionPreview')?.visible, 'Selection and recoloring retain voxel buffers and show selection overlays')
    renderer.applySelection({ cells: [], count: 0 }, false)
    for (const tool of ['layer', 'paint', 'select', 'sculpt'] as const) {
      renderer.setToolState(tool, tool === 'paint' ? 'fill' : 'paint')
      await presented()
      check(instanceCount() === (tool === 'layer' || tool === 'paint' ? 7 : 2), `${tool}: sprite scope must match tool semantics`)
    }
    renderer.setAuxiliary('pick'); await presented()
    check(instanceCount() === 7, 'Eyedropper uses the visible composition')
    renderer.setAuxiliary(); await presented()
    model.setActiveLayer(context.id); renderer.refreshLayerScope(); await presented()
    check(instanceCount() === 7, 'Layer activation updates live instances')
    model.setActiveLayer(active); renderer.refreshLayerScope(); await presented()
    check(instanceCount() === 2, 'Returning to the active layer restores its voxels')
    renderer.setSettings({ ...viewport.settings, faceGrid: true, meshVertices: true, meshTriangles: true })
    await presented()
    const helpers: THREE.Object3D[] = []
    viewport.content!.root.traverseVisible(object => helpers.push(object))
    for (const key of ['layerContext', 'faceGrid', 'meshVertices', 'meshTriangles']) check(helpers.some(object => object.userData[key]), `${key} must remain visible with live sprites`)
    renderer.setSettings({ ...viewport.settings, faceGrid: false, meshVertices: false, meshTriangles: false })
    await presented()
    const beforeInspection = await pixels(renderer)
    await renderer.inspect(['iso-front-left', 'iso-back-right'])
    await presented()
    check(instanceCount() === 2 && difference(beforeInspection, await pixels(renderer)) < 0.01, 'Inspection restores isolated live rendering')
    model.setVoxel(15, 2, 7, 0)
    renderer.markDirty(dirtyChunks(model, [model.idAt(15, 2, 7)]))
    await presented()
    check(instanceCount() === 1 && difference(isolated, await pixels(renderer)) > 0, 'Live edits and deletion update sprite buffers')
    model.activeLayer.visible = false; renderer.refreshLayerScope(); renderer.markDirty(model.chunks.keys())
    await presented()
    check(instanceCount() === 0, 'A hidden active layer contributes no opaque sprites')
    model.activeLayer.visible = true; renderer.refreshLayerScope(); renderer.markDirty(model.chunks.keys())
    await presented()
    renderer.setRenderMode(true); await presented()
    check(instanceCount() === 7, 'Render mode uses full visible composition')
    renderer.setRenderMode(false); await presented()
    check(instanceCount() === 1, 'Leaving Render mode restores editing scope')
    renderer.setSettings({ ...viewport.settings, previewRenderer: 'standard' }); await presented()
    check(!sprites.root.visible && physical().every(material => material.visible), 'Standard restores conventional material visibility')
    renderer.setSettings({ ...viewport.settings, previewRenderer: 'cube-sprites' }); await presented()
    renderer.setDocument(new VoxelDocument({ x: 32, y: 16, z: 16 }), true); await presented()
    check(instanceCount() === 0 && physical().every(material => !material.visible), 'Document replacement clears old instances and preserves renderer choice')
    check(errors.length === 0, errors.join('\n'))
    return { liveUpdates: true, scopedPicking: true, helperOverlays: true, inspection: true, switching: true, errors }
  } finally { renderer.dispose(); host.remove() }
}
