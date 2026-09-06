// Run with `bunx vite --config tests/vite.config.ts`, then open /tests/transparency.html.
import { VoxelDocument } from '../src/editor'
import { VoxelRenderer, type RendererCallbacks } from '../src/renderer'
import type { ViewSettings } from '../src/storage'

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
  background: '#dfe7ec', ambient: 1.2, light: 2.4, lightAzimuth: 42,
  ambientOcclusion: false, shadows: false, grid: false, faceGrid: false,
  projection: 'perspective', pathTracing: true,
}
const renderer = new VoxelRenderer(host, new VoxelDocument(), settings, callbacks)

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

Object.assign(window, { transparencyTest: {
  renderer, scene, pixel, errors, settings, runRasterChecks,
  get status() { return status },
} })
await scene('pool')
