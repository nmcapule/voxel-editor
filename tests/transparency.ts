// Run with `bunx vite --config tests/vite.config.ts`, then open /tests/transparency.html.
import { VoxelDocument } from '../src/shared/voxel/document'
import type { Vec3 } from '../src/shared/voxel/document'
import type { Object3D } from 'three'
import { faceViews, projectFaces } from '../src/shared/voxel/projections'
import { inspectionViews, type InspectionView } from '../src/editors/model/inspection'
import { VoxelRenderer, type RendererCallbacks } from '../src/editors/model/renderer'
import { DEFAULT_SETTINGS, type ViewSettings } from '../src/shared/rendering/settings'
import { runRenderingChecks, runRendererStateChecks, runPathTracingChecks, runTiltShiftChecks, runInteractionDprChecks } from './rendering'
import { runSkyboxChecks } from './skybox'
import { runOcclusionChecks, runOcclusionBenchmark } from './occlusion'

const host = document.createElement('div')
host.style.cssText = 'width:100vw;height:100vh'
document.body.append(host)
const errors: string[] = []
let status = ''
const callbacks = new Proxy({
  onError: (message: string) => errors.push(message),
  onPathTracingStatus: (message: string) => { status = message },
}, { get: (target, key) => target[key as keyof typeof target] ?? (() => {}) }) as unknown as RendererCallbacks
const settings: ViewSettings = {
  ...DEFAULT_SETTINGS, ambientOcclusion: false, shadows: false, grid: false, projection: 'perspective',
}
const renderer = new VoxelRenderer(host, new VoxelDocument(), settings, callbacks)
const viewport = renderer.viewport

async function scene(kind: 'pool' | 'stack' | 'water', water = true, reverse = false, chunked = true) {
  renderer.setRenderMode(false)
  const size = chunked ? 32 : 16
  const min = size / 2 - 6, max = size / 2 + 6
  const document = new VoxelDocument({ x: size, y: 32, z: size })
  for (let x = min; x < max; x++) for (let z = min; z < max; z++) for (let y = 0; y < 5; y++) {
    const solid = y === 0 || kind === 'pool' && (x === min || x === max - 1 || z === min || z === max - 1)
    const color = solid ? 1 : kind === 'stack' && y === 4 ? (reverse ? 12 : 31) : water ? (reverse ? 31 : 12) : 0
    if (color) document.setVoxel(x, y, z, color)
  }
  renderer.setDocument(document)
  await renderer.whenMeshIdle()
  renderer.setView({ position: { x: 19, y: 20, z: 19 }, target: { x: 0, y: 2, z: 0 }, fov: 35 })
  return document
}

async function pixel(x = 0.5, y = 0.5) {
  const { blob } = await renderer.capture()
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data]
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function runRasterChecks() {
  renderer.setRenderMode(false)
  renderer.setSettings(settings)
  const document = await scene('water')
  // Check the actual materials used by both renderers, including live palette updates.
  const materials = Reflect.get(renderer, 'materials') as { opacity: number; transparent: boolean; depthWrite: boolean }[]
  check(materials[12].opacity === 1 && !materials[12].transparent && materials[12].depthWrite, 'Water must use transmission, not alpha holes')
  document.materials[12].transmission = 0.9
  renderer.updatePaletteMaterial(12)
  check(materials[12].opacity === 1 && !materials[12].transparent, 'Updating transmission must not change opacity')
  document.materials[12].opacity = 0.5
  renderer.updatePaletteMaterial(12)
  check(materials[12].opacity === 0.5 && materials[12].transparent && !materials[12].depthWrite, 'Authored opacity must still work')

  const comparisons = []
  for (const reverse of [false, true]) {
    await scene('stack', true, reverse)
    const withWater = await pixel()
    await scene('stack', false, reverse)
    const withoutWater = await pixel()
    check(withWater.slice(0, 3).some((value, i) => Math.abs(value - withoutWater[i]) > 5), 'The rear transparent layer must affect the image')
    comparisons.push({ reverse, withWater, withoutWater })
  }
  await scene('water', true, false, true)
  const chunked = await Promise.all([pixel(0.45, 0.4), pixel(), pixel(0.55, 0.5)])
  await scene('water', true, false, false)
  const unchunked = await Promise.all([pixel(0.45, 0.4), pixel(), pixel(0.55, 0.5)])
  check(chunked.every((rgba, i) => rgba.every((value, j) => Math.abs(value - unchunked[i][j]) <= 2)), 'Chunk boundaries must not re-tint the same water')
  const stacked = await scene('stack')
  const before = await pixel()
  stacked.setVoxel(31, 31, 31, 12)
  renderer.markDirty(stacked.chunks.keys())
  const after = await pixel()
  check(before.every((value, i) => Math.abs(value - after[i]) <= 1), 'Offscreen water must not change visible material ordering')
  check(errors.length === 0, errors.join('\n'))
  await scene('pool')
  return { comparisons, chunked, unchunked }
}

async function runInspectionChecks() {
  renderer.setRenderMode(false)
  renderer.setSettings({ ...settings, pathTracing: false, grid: true, faceGrid: true, meshVertices: true, meshTriangles: true })
  const fixture = new VoxelDocument({ x: 19, y: 23, z: 29 })
  // Unequal extents, boundary voxels and overlapping rays expose flips, depth and framing errors.
  for (let x = 0; x < 8; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 12; z++) {
    fixture.setVoxel(x, y, z, 7)
  }
  for (const [x, y, z, color] of [[18, 22, 28, 11], [2, 17, 6, 14], [2, 17, 25, 5], [15, 17, 6, 9], [2, 3, 6, 1]]) {
    fixture.setVoxel(x, y, z, color)
  }
  renderer.setDocument(fixture)
  await renderer.whenMeshIdle()
  renderer.applySelection({ cells: [{ x: 0, y: 0, z: 0 }, { x: 18, y: 22, z: 28 }], count: 2 }, false)
  renderer.setView({ position: { x: 41, y: 33, z: -27 }, target: { x: 2, y: 7, z: -3 }, fov: 47 })
  const sceneObject = viewport.scene
  const snapshot = () => {
    const visibility: [string, boolean][] = []
    sceneObject.traverse(object => visibility.push([object.uuid, object.visible]))
    return JSON.stringify({
      view: renderer.getView(), settings: viewport.settings,
      selection: [...Reflect.get(renderer, 'selection') as Map<number, Vec3>],
      floating: Reflect.get(renderer, 'floatingSelection'), renderMode: viewport.renderMode, visibility,
    })
  }
  const inspect = async (views?: readonly InspectionView[]) => {
    const before = snapshot()
    const images = await renderer.inspect(views)
    check(snapshot() === before, 'Inspection must preserve view, settings, selection and scene visibility')
    return Promise.all(images.map(async image => {
      check(image.blob.type === 'image/png', `${image.name}: expected a PNG blob`)
      const bitmap = await createImageBitmap(image.blob)
      try {
        check(bitmap.width === image.width && bitmap.height === image.height, `${image.name}: decoded dimensions must match metadata`)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        return { ...image, rgba: context.getImageData(0, 0, image.width, image.height).data }
      } finally {
        bitmap.close()
      }
    }))
  }
  const equalPixels = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && a.every((value, i) => value === b[i])
  const checkFaces = (images: Awaited<ReturnType<typeof inspect>>, document: VoxelDocument) => {
    for (const expected of projectFaces(document)) {
      const image = images.find(image => image.name === expected.name)
      check(!!image, `${expected.name}: missing face`)
      check(image!.width === expected.width && image!.height === expected.height, `${expected.name}: incorrect face dimensions`)
      check(image!.direction === expected.direction && image!.pixelAxes === expected.pixelAxes, `${expected.name}: incorrect orientation metadata`)
      check(equalPixels(image!.rgba, expected.rgba), `${expected.name}: decoded RGBA must match projectFaces byte for byte`)
    }
  }
  const defaults = await inspect()
  check(defaults.length === 7 && defaults.map(image => image.name).join() === [...faceViews, 'iso-front-right'].join(), 'Default inspection must return six faces and iso-front-right in order')
  checkFaces(defaults, fixture)
  check((await inspect([])).length === 0, 'An empty view request must return no images')

  const overlays = new Map<Object3D, boolean>()
  for (const [owner, keys] of [
    [viewport, ['grid', 'limits', 'ground']],
    [renderer, ['hover', 'marqueePreview', 'selectionPreview', 'fillPreview', 'pushPullPreview']],
  ] as const) for (const key of keys) {
    const object = Reflect.get(owner, key) as Object3D | undefined
    if (object) overlays.set(object, object.visible)
  }
  let faceGrids = 0
  let meshVertices = 0
  let meshTriangles = 0
  sceneObject.traverse(object => {
    if (object.userData.faceGrid) { overlays.set(object, object.visible); faceGrids++ }
    if (object.userData.meshVertices) { overlays.set(object, object.visible); meshVertices++ }
    if (object.userData.meshTriangles) { overlays.set(object, object.visible); meshTriangles++ }
  })
  check(faceGrids > 0 && meshVertices > 0 && meshTriangles > 0 && !!Reflect.get(renderer, 'selectionPreview'), 'Fixture must contain face grids, mesh vertices, mesh triangles and a selection overlay')
  let populated: Awaited<ReturnType<typeof inspect>>
  try {
    for (const object of overlays.keys()) object.visible = true
    populated = await inspect(inspectionViews)
    check(populated.map(image => image.name).join() === inspectionViews.join(), 'Explicit inspection must return all requested views in order')
    checkFaces(populated, fixture)
    for (const object of overlays.keys()) object.visible = false
    const hidden = await inspect(inspectionViews)
    check(hidden.every((image, i) => equalPixels(image.rgba, populated[i].rgba)), 'Overlay visibility must not affect any inspection pixels')

    // Mixed visibility catches restoration that blindly turns every object back on.
    let index = 0
    for (const object of overlays.keys()) object.visible = index++ % 2 === 0
    const before = snapshot()
    const webgl = viewport.renderer
    const original = webgl.readRenderTargetPixels
    const failure = new Error('Inspection readback failure')
    let called = false
    let caught: unknown
    try {
      Reflect.set(webgl, 'readRenderTargetPixels', () => {
        called = true
        check([...overlays.keys()].every(object => !object.visible), 'Readback must run with overlays hidden')
        throw failure
      })
      try { await renderer.inspect(['iso-back-left']) } catch (error) { caught = error }
    } finally {
      Reflect.set(webgl, 'readRenderTargetPixels', original)
    }
    check(called && caught === failure, 'Inspection must propagate the injected readback failure')
    check(snapshot() === before, 'Failed inspection must restore scene visibility, view, settings and selection')
    const recovered = await inspect(['iso-back-left'])
    check(equalPixels(recovered[0].rgba, populated.find(image => image.name === 'iso-back-left')!.rgba), 'Inspection must work again after readback failure')
  } finally {
    for (const [object, visible] of overlays) object.visible = visible
    renderer.render()
  }

  const emptyDocument = new VoxelDocument(fixture.dimensions)
  renderer.setDocument(emptyDocument)
  await renderer.whenMeshIdle()
  const empty = await inspect(inspectionViews)
  checkFaces(empty, emptyDocument)
  for (const image of empty.filter(image => !image.name.startsWith('iso-'))) {
    check(image.rgba.every((value, i) => i % 4 !== 3 || value === 0), `${image.name}: empty face alpha must be zero everywhere`)
  }
  const isometric = populated.filter(image => image.name.startsWith('iso-'))
  check(isometric.length === 4, 'All four isometric views must be returned')
  for (const [i, image] of isometric.entries()) {
    const blank = empty.find(empty => empty.name === image.name)!
    check(image.width === 512 && image.height === 512 && blank.width === 512 && blank.height === 512, `${image.name}: isometric PNGs must be 512x512`)
    const x = image.name.endsWith('right') ? 1 : -1
    const z = image.name.includes('front') ? 1 : -1
    check(image.direction.includes(`(${x},1,${z})`) && image.direction.includes('orthographic') && image.pixelAxes === undefined, `${image.name}: incorrect isometric metadata`)
    const background = blank.rgba.slice(0, 4)
    check(background[3] === 255 && blank.rgba.every((value, j) => value === background[j % 4]), `${image.name}: empty isometric must be uniform opaque background`)
    check(!equalPixels(image.rgba, blank.rgba), `${image.name}: populated isometric must not be blank`)
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      if (x !== 0 && y !== 0 && x !== 511 && y !== 511) continue
      const offset = (y * 512 + x) * 4
      check(background.every((value, channel) => image.rgba[offset + channel] === value), `${image.name}: framing must leave background along the entire border`)
    }
    for (const other of isometric.slice(i + 1)) check(!equalPixels(image.rgba, other.rgba), `${image.name} and ${other.name}: asymmetric fixture must produce different pixels`)
  }
  return { defaults: defaults.map(image => image.name), faces: faceViews.length, isometric: isometric.map(image => image.name), failureRestored: true }
}

Object.assign(window, { transparencyTest: {
  renderer, scene, pixel, errors, settings, runRasterChecks, runInspectionChecks,
  runRenderingChecks: () => runRenderingChecks(renderer, settings, errors),
  runRendererStateChecks: () => runRendererStateChecks(renderer),
  runPathTracingChecks: (samples = 16) => runPathTracingChecks(renderer, settings, errors, samples),
  runTiltShiftChecks: () => runTiltShiftChecks(renderer, settings, errors),
  runInteractionDprChecks: () => runInteractionDprChecks(renderer, settings, errors),
  runSkyboxChecks: (samples = 8) => runSkyboxChecks(renderer, settings, errors, samples),
  runOcclusionChecks: () => runOcclusionChecks(renderer, settings, errors),
  runOcclusionBenchmark: () => runOcclusionBenchmark(renderer, settings, errors),
  get status() { return status },
} })
await scene('pool')
