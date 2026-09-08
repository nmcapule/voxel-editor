// Dedicated /tests/transparency.html harness; run suites sequentially, benchmark separately.
// Live parity deliberately reads the preserved canvas, never capture() (which bypasses culling).
import type { Material, Object3D } from 'three'
import type { VoxelRenderer } from '../src/editors/model/renderer'
import type { ModelOcclusion } from '../src/editors/model/occlusion'
import type { RasterPipeline } from '../src/shared/rendering/raster-pipeline'
import type { ViewSettings } from '../src/shared/rendering/settings'
import type { Vec3 } from '../src/shared/voxel/document'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function until(condition: () => boolean, message: string, timeout = 30000) {
  const deadline = performance.now() + timeout
  while (!condition()) {
    check(performance.now() < deadline, `Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function difference(a: ImageData, b: ImageData) {
  check(a.width === b.width && a.height === b.height && a.data.length > 0, 'Pixel dimensions must match')
  let sum = 0, max = 0, changedPixels = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let changed = false
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a.data[i + c] - b.data[i + c])
      sum += delta; max = Math.max(max, delta); changed ||= delta > 2
    }
    changedPixels += Number(changed)
  }
  return { mean: sum / a.data.length, max, changedPixels }
}

function sourceState(root: Object3D) {
  const objects: { object: Object3D; visible: boolean; castShadow: boolean; material: unknown }[] = []
  const materials = new Map<Material, { visible: boolean; depthWrite: boolean; opacity: number }>()
  root.traverse(object => {
    const material = Reflect.get(object, 'material') as Material | Material[] | undefined
    objects.push({ object, visible: object.visible, castShadow: object.castShadow, material })
    for (const item of material ? Array.isArray(material) ? material : [material] : []) {
      materials.set(item, { visible: item.visible, depthWrite: item.depthWrite, opacity: item.opacity })
    }
  })
  return () => {
    for (const { object, visible, castShadow, material } of objects) {
      check(object.visible === visible && object.castShadow === castShadow && Reflect.get(object, 'material') === material,
        `Source visibility/material identity leaked: ${object.name || object.uuid}`)
    }
    for (const [material, state] of materials) check(Object.entries(state).every(([key, value]) => Reflect.get(material, key) === value),
      `Source material flags leaked: ${material.name || material.uuid}`)
  }
}

async function withOcclusionViewport<T>(renderer: VoxelRenderer, settings: ViewSettings, errors: string[],
  run: (harness: {
    baseline: ViewSettings
    fixture: (shape?: 'wall-detail' | 'sparse' | 'checkerboard', multimat?: boolean) => { document: import('../src/shared/voxel/document').VoxelDocument; wallLayer: number }
    load: (document: import('../src/shared/voxel/document').VoxelDocument) => Promise<void>
    idle: () => Promise<void>
    live: () => { pipeline: RasterPipeline['lastFrame']; culling: ModelOcclusion['lastFrame'] | undefined }
    pixels: () => ImageData
    healthy: () => void
  }) => Promise<T>) {
  const { VoxelDocument } = await import('../src/shared/voxel/document')
  const viewport = renderer.viewport, webgl = viewport.renderer
  const host = Reflect.get(viewport, 'host') as HTMLElement
  const saved = {
    document: Reflect.get(renderer, 'document') as InstanceType<typeof VoxelDocument>,
    materials: Reflect.get(renderer, 'materials'), settings: { ...viewport.settings },
    view: renderer.getView(), renderMode: viewport.renderMode, culling: renderer.occlusionCulling,
    width: host.style.width, height: host.style.height, ratio: webgl.getPixelRatio(),
    dpr: Object.getOwnPropertyDescriptor(window, 'devicePixelRatio'),
    selection: [...(Reflect.get(renderer, 'selection') as Map<number, Vec3>).values()],
    floating: Reflect.get(renderer, 'floatingSelection') as boolean,
    tool: Reflect.get(renderer, 'tool') as Parameters<VoxelRenderer['setToolState']>[0],
    paint: Reflect.get(renderer, 'paintMode') as Parameters<VoxelRenderer['setToolState']>[1],
    auxiliary: Reflect.get(renderer, 'auxiliary') as Parameters<VoxelRenderer['setToolState']>[2],
    sculpt: Reflect.get(renderer, 'sculptMode') as Parameters<VoxelRenderer['setSculptMode']>[0],
    shadowAutoUpdate: webgl.shadowMap.autoUpdate, infoAutoReset: webgl.info.autoReset,
    shaderError: webgl.debug.onShaderError, visibility: new Map<Object3D, boolean>(),
  }
  viewport.scene.traverse(object => saved.visibility.set(object, object.visible))
  const errorStart = errors.length
  const onError = (event: ErrorEvent) => errors.push(`uncaught: ${event.error?.stack ?? event.message}`)
  const onRejection = (event: PromiseRejectionEvent) => errors.push(`unhandled rejection: ${event.reason?.stack ?? event.reason}`)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  webgl.debug.onShaderError = (gl, program, vertex, fragment) => {
    errors.push(`shader: ${[gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join('\n')}`)
    saved.shaderError?.(gl, program, vertex, fragment)
  }
  const healthy = () => {
    check(errors.length === errorStart, errors.slice(errorStart).join('\n'))
    check(!webgl.getContext().isContextLost() && !renderer.meshState().failed, 'Context and mesher must remain healthy')
  }
  const idle = () => until(() => {
    healthy()
    return renderer.meshState().pending === 0 && Reflect.get(viewport, 'rasterFrame') === undefined
      && !Reflect.get(viewport, 'presentationDirty') && !Reflect.get(viewport, 'pathTracingBuildRunning')
  }, 'idle live raster')
  const baseline: ViewSettings = { ...settings, previewRenderer: 'standard', projection: 'orthographic',
    skybox: 'solid', background: '#263240', ambient: 1.2, light: 2.4, lightAzimuth: 42,
    pbrMaterials: true, pathTracing: false, tiltShift: false, ambientOcclusion: false, shadows: false,
    grid: false, faceGrid: false, meshVertices: false, meshTriangles: false }
  const fixture = (shape: 'wall-detail' | 'sparse' | 'checkerboard' = 'wall-detail', multimat = false) => {
    const document = new VoxelDocument({ x: 64, y: 64, z: 64 })
    for (const [index, color] of [[40, 0xd48b35], [41, 0x6dbd76], [42, 0x44bfff], [43, 0xe65b76]]) {
      document.palette[index] = color
      Object.assign(document.materials[index], { opacity: 1, transmission: 0, roughness: 0.8, metalness: 0, emissiveIntensity: 0, ior: 1 })
    }
    if (shape === 'wall-detail') {
      // Unit faces cannot become blockers; expensive rear surfaces occupy 48 separate chunks.
      for (let z = 4; z < 48; z += 4) for (let y = 4; y < 60; y += 4) for (let x = 4; x < 60; x += 4) {
        document.setVoxel(x, y, z, 42 + ((x + y + z) / 4 % 2))
      }
      const active = document.activeLayerId, wallLayer = document.createLayer().id
      // Sixteen front chunks; the interior palette seam is not a physical opening.
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) document.setVoxel(x, y, 55, multimat ? 40 + (Math.floor(x / 8) % 2) : 40)
      document.setActiveLayer(active)
      return { document, wallLayer }
    }
    // 64 populated chunks, not a full 64^3 checkerboard's 786k exposed quads.
    for (let cz = 0; cz < 4; cz++) for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
      for (let z = 5; z < 9; z++) for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) {
        if (shape === 'sparse' ? x === y && y === z : (x + y + z) % 2 === 0) document.setVoxel(cx * 16 + x, cy * 16 + y, cz * 16 + z, 42)
      }
    }
    return { document, wallLayer: document.activeLayerId }
  }
  const live = () => {
    // Own the scheduled request while measuring this exact camera, without an intervening RAF.
    const scheduled = Reflect.get(viewport, 'rasterFrame') as number | undefined
    if (scheduled !== undefined) cancelAnimationFrame(scheduled)
    Reflect.set(viewport, 'rasterFrame', undefined)
    const raster = Reflect.get(viewport, 'raster') as RasterPipeline
    Reflect.get(viewport, 'renderRaster').call(viewport, viewport.camera, raster, !Reflect.get(viewport, 'pathTracingEnabled').call(viewport), true)
    check(raster.lastFrame.complete, 'Live frame must complete')
    const occlusion = Reflect.get(renderer, 'occlusion') as ModelOcclusion | undefined
    return { pipeline: { ...raster.lastFrame }, culling: occlusion && { ...occlusion.lastFrame } }
  }
  const pixels = () => {
    const canvas = webgl.domElement, copy = new OffscreenCanvas(canvas.width, canvas.height)
    const context = copy.getContext('2d')!
    context.drawImage(canvas, 0, 0)
    return context.getImageData(0, 0, copy.width, copy.height)
  }
  let borrowedMaterials = false
  try {
    renderer.setRenderMode(false)
    renderer.setSettings(baseline)
    renderer.occlusionCulling = false
    Reflect.get(viewport, 'clearRasterInteractions').call(viewport)
    await idle()
    host.style.width = host.style.height = `${Math.floor(192 / Math.min(devicePixelRatio, 2))}px`
    renderer.resize()
    renderer.setToolState('select', 'paint')
    renderer.clearSelection()
    webgl.shadowMap.autoUpdate = false
    // setDocument normally disposes maps. Keep the caller's authored material objects alive.
    Reflect.set(renderer, 'materials', [])
    borrowedMaterials = true
    const result = await run({ baseline, fixture, live, pixels, idle, healthy, load: async document => {
      renderer.setDocument(document)
      await idle()
    } })
    healthy()
    return result
  } finally {
    try {
      renderer.setRenderMode(false)
      renderer.occlusionCulling = false
      Reflect.get(viewport, 'clearRasterInteractions').call(viewport)
      if (saved.dpr) Object.defineProperty(window, 'devicePixelRatio', saved.dpr)
      else Reflect.deleteProperty(window, 'devicePixelRatio')
      if (borrowedMaterials) {
        Reflect.get(renderer, 'disposeMaterials').call(renderer)
        Reflect.set(renderer, 'materials', saved.materials)
        renderer.setDocument(saved.document, true)
      }
      renderer.setSettings(saved.settings)
      renderer.setToolState(saved.tool, saved.paint, saved.auxiliary)
      renderer.setSculptMode(saved.sculpt)
      renderer.applySelection({ cells: saved.selection, count: saved.selection.length, floating: saved.floating }, false)
      host.style.width = saved.width; host.style.height = saved.height
      renderer.setView(saved.view)
      renderer.occlusionCulling = saved.culling
      webgl.shadowMap.autoUpdate = saved.shadowAutoUpdate
      webgl.info.autoReset = saved.infoAutoReset
      try {
        // A recorded test error must not short-circuit restoration of the caller's mode/DPR.
        await until(() => renderer.meshState().failed || renderer.meshState().pending === 0
          && Reflect.get(viewport, 'rasterFrame') === undefined, 'restored fixture meshes')
      } finally {
        if (saved.renderMode) renderer.setRenderMode(true)
        viewport.scene.traverse(object => { if (saved.visibility.has(object)) object.visible = saved.visibility.get(object)! })
        renderer.render()
        // resize/render applies the interaction policy; restore an explicitly supplied ratio last.
        webgl.setPixelRatio(saved.ratio)
        const raster = Reflect.get(viewport, 'raster') as RasterPipeline
        raster.setSize(webgl.domElement.width, webgl.domElement.height)
      }
      healthy()
    } finally {
      webgl.debug.onShaderError = saved.shaderError
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }
}

export async function runOcclusionChecks(renderer: VoxelRenderer, settings: ViewSettings, errors: string[]) {
  const { EditSession, History, dirtyChunks } = await import('../src/shared/voxel/document')
  return withOcclusionViewport(renderer, settings, errors, async ({ baseline, fixture, load, idle, live, pixels, healthy }) => {
    const viewport = renderer.viewport, webgl = viewport.renderer
    const results: object[] = []
    const view = (angle = 0, radius = 130, zoom = 1, elevation = 0) => renderer.setView({
      position: { x: Math.sin(angle) * radius, y: 32 + elevation, z: Math.cos(angle) * radius },
      target: { x: 0, y: 32, z: 0 }, up: { x: 0, y: 1, z: 0 }, fov: 45, orthographicSpan: 84, zoom,
    })
    const compare = (name: string, expected?: 'positive' | 'zero') => {
      const restored = sourceState(viewport.scene)
      // Read the existing culler first: toggling off/on beforehand would hide stale-remesh bugs.
      renderer.occlusionCulling = true
      const on = live(), actual = pixels()
      restored()
      renderer.occlusionCulling = false
      const off = live(), reference = pixels()
      restored()
      check(off.pipeline.occludedMeshes === 0, `${name}: disabled path must suppress no surfaces`)
      renderer.occlusionCulling = true
      const delta = difference(reference, actual)
      healthy()
      check(delta.max <= 2, `${name}: live pixels differ: ${JSON.stringify(delta)}`)
      if (expected === 'positive') check(on.pipeline.occludedMeshes > 0 && on.culling!.culledChunks > 0 && on.culling!.occluders > 0,
        `${name}: must actually suppress rear surface draws: ${JSON.stringify(on)}`)
      if (expected === 'zero') check(on.pipeline.occludedMeshes === 0, `${name}: exposed surfaces must remain drawn: ${JSON.stringify(on)}`)
      check(on.pipeline.occludedMeshes === on.culling?.culledMeshes, `${name}: provider and actual suppressed surface counts disagree`)
      results.push({ name, delta, ...on })
      return reference
    }

    await load(fixture().document)
    for (const projection of ['orthographic', 'perspective'] as const) {
      renderer.setSettings({ ...baseline, projection })
      if (projection === 'orthographic') check(viewport.camera.near < 0, 'Exercise the real negative orthographic near plane')
      // Build disabled references first, then keep one culler through the entire camera sweep.
      const views = [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI / 3, 0]
        .map((angle, i) => ({ angle, radius: i === 7 ? 95 : 130, zoom: i === 7 ? 1.6 : 1, elevation: i % 2 ? 12 : 0 }))
      const references: ImageData[] = []
      renderer.occlusionCulling = false
      for (const camera of views) { view(camera.angle, camera.radius, camera.zoom, camera.elevation); live(); references.push(pixels()) }
      check(difference(references[0], references[4]).mean > 1, 'Rear orbit must visibly reveal the expensive detail')
      renderer.occlusionCulling = true
      for (const [i, camera] of views.entries()) {
        view(camera.angle, camera.radius, camera.zoom, camera.elevation)
        const restored = sourceState(viewport.scene), frame = live(), delta = difference(references[i], pixels())
        restored(); healthy()
        check(delta.max <= 2, `${projection} orbit ${i}: ${JSON.stringify(delta)}`)
        if (i === 0) check(frame.pipeline.occludedMeshes > 0, `${projection}: chunk-seamed wall must skip real draws`)
        if (i === 4) check(frame.pipeline.occludedMeshes === 0, `${projection}: rear reveal cannot reuse the front result`)
        results.push({ name: `${projection} orbit ${i}`, camera, delta, ...frame })
      }
      if (projection === 'orthographic') {
        // The eye is behind the wall, but negative-near parallel rays still see its front.
        view(0, 20)
        compare('orthographic blocker behind eye', 'positive')
      } else {
        for (const z of [24.05, 23.95]) { view(0, z); compare(`perspective wall near-plane crossing ${z}`, 'zero') }
      }
    }

    const { document, wallLayer } = fixture('wall-detail', true)
    renderer.setSettings(baseline)
    await load(document)
    view()
    const solid = compare('opaque multimat wall', 'positive')
    for (const opening of ['hole', 'slit', 'deletion'] as const) {
      const history = new History(), edit = new EditSession(document, wallLayer)
      const min = opening === 'hole' ? { x: 28, y: 28, z: 55 } : { x: opening === 'slit' ? 31 : 0, y: 0, z: 55 }
      const max = opening === 'hole' ? { x: 35, y: 35, z: 55 } : { x: opening === 'slit' ? 32 : 63, y: 63, z: 55 }
      edit.fill(min, max, 0)
      const command = edit.commit()
      check(command, `${opening}: edit must change real voxel chunks`)
      history.push(command)
      renderer.markDirty(dirtyChunks(document, command.changes.map(change => change.id)))
      await idle()
      const opened = compare(`remeshed ${opening}`, opening === 'deletion' ? 'zero' : undefined)
      check(difference(solid, opened).mean > 0.01, `${opening}: opening must visibly change the reference`)
      const undo = history.undo(document)
      check(undo, 'Undo must restore the occluder')
      renderer.markDirty(dirtyChunks(document, undo.ids))
      await idle()
      check(difference(solid, compare(`undo ${opening}`, 'positive')).max <= 2, 'Undo must restore original pixels')
      if (opening === 'deletion') {
        const redo = history.redo(document)!
        renderer.markDirty(dirtyChunks(document, redo.ids)); await idle()
        compare('redo occluder deletion', 'zero')
        renderer.markDirty(dirtyChunks(document, history.undo(document)!.ids)); await idle()
      }
    }

    for (const [name, opacity, transmission] of [['alpha', 0.4, 0], ['transmission', 1, 0.8], ['opaque again', 1, 0]] as const) {
      for (const index of [40, 41]) { Object.assign(document.materials[index], { opacity, transmission }); renderer.updatePaletteMaterial(index) }
      await idle()
      compare(`material transition: ${name}`, name === 'opaque again' ? 'positive' : 'zero')
      if (name === 'transmission') {
        renderer.setSettings({ ...baseline, pbrMaterials: false })
        compare('PBR-off opaque substitutes', 'positive')
        renderer.setSettings(baseline)
        compare('PBR-on restores transmission eligibility', 'zero')
      }
    }
    renderer.applySelection({ cells: [{ x: 32, y: 32, z: 44 }], count: 1 }, false)
    await idle()
    check(Reflect.get(renderer, 'meshLayerId') === document.activeLayerId, 'Selection must activate real layer isolation')
    const isolated = compare('selection isolates detail from context wall', 'zero')
    check(difference(solid, isolated).mean > 0.01, 'Ghost context must visibly reveal the selected layer')
    renderer.setRenderMode(true); await idle()
    compare('render mode restores full composition', 'positive')
    renderer.setRenderMode(false); renderer.clearSelection(); await idle()
    compare('clear selection restores normal meshes', 'positive')

    renderer.setSettings({ ...baseline, ambientOcclusion: true, shadows: true })
    await idle()
    const shadowMap = webgl.shadowMap
    for (const autoUpdate of [false, true]) {
      renderer.occlusionCulling = true
      shadowMap.autoUpdate = autoUpdate; shadowMap.needsUpdate = true
      const restored = sourceState(viewport.scene), refresh = live(), reference = pixels()
      restored()
      check(refresh.pipeline.occludedMeshes === 0, 'Shadow refresh must bypass culling')
      check(Reflect.get(viewport, 'sunlight').shadow.map && !shadowMap.needsUpdate, 'Refresh must populate a clean real shadow map')
      renderer.occlusionCulling = false; shadowMap.needsUpdate = true; live()
      check(difference(reference, pixels()).max <= 2, 'AO plus refreshed shadows must retain unculled pixels')
      // Provider stats retain the preceding invocation when the pipeline bypasses the callback.
      results.push({ name: `shadow refresh autoUpdate=${autoUpdate}`, pipeline: refresh.pipeline, bypass: true })
    }
    shadowMap.autoUpdate = false
    compare('AO plus cached shadows', 'positive')
    view(0.08)
    check(!shadowMap.needsUpdate, 'Ordinary camera movement must retain the shadow cache')
    compare('orbit with cached shadows', 'positive')

    renderer.setSettings(baseline); view(); await idle()
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    renderer.resize(); await idle()
    const sharp = compare('full-DPR live frame', 'positive'), fullView = renderer.getView()
    viewport.controls.dispatchEvent({ type: 'start' })
    check(webgl.getPixelRatio() === 1, 'Interaction start must select reduced DPR')
    compare('interactive-DPR live frame', 'positive')

    // Observe pipeline entry points, not object hooks (custom hooks disable eligibility).
    const descriptor = Object.getOwnPropertyDescriptor(viewport, 'renderRaster'), original = Reflect.get(viewport, 'renderRaster')
    const secondary: { capture: boolean; inspection: boolean; skipped: number }[] = []
    Reflect.set(viewport, 'renderRaster', function (this: typeof viewport, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args)
      if (!args[3]) {
        const raster = (args[1] ?? Reflect.get(this, 'raster')) as RasterPipeline
        secondary.push({ capture: Reflect.get(this, 'captures') > 0, inspection: !!args[0] && args[0] !== this.camera, skipped: raster.lastFrame.occludedMeshes })
        check(raster.lastFrame.occludedMeshes === 0, 'Secondary render must bypass culling')
      }
      return result
    })
    try {
      const restored = sourceState(viewport.scene)
      const capture = await renderer.capture()
      const bitmap = await createImageBitmap(capture.blob)
      try { check(bitmap.width === sharp.width && bitmap.height === sharp.height, 'Capture during interaction must use full DPR') }
      finally { bitmap.close() }
      restored()
      check(webgl.getPixelRatio() === 1, 'Capture must restore interactive DPR')
      viewport.controls.dispatchEvent({ type: 'end' })
      await until(() => Reflect.get(viewport, 'rasterRestoreTimer') === undefined, 'DPR settling')
      await idle()
      check(webgl.getPixelRatio() === 2 && JSON.stringify(renderer.getView()) === JSON.stringify(fullView), 'DPR settling must restore dimensions without moving the camera')
      check(difference(sharp, compare('settled-DPR live frame', 'positive')).max <= 2, 'Settled pixels must match the sharp reference')
      const decode = async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob)
        try {
          const copy = new OffscreenCanvas(bitmap.width, bitmap.height), context = copy.getContext('2d')!
          context.drawImage(bitmap, 0, 0)
          return context.getImageData(0, 0, copy.width, copy.height)
        } finally { bitmap.close() }
      }
      const inspections: ImageData[][] = [], captures: ImageData[] = []
      for (const enabled of [false, true]) {
        renderer.occlusionCulling = enabled
        live()
        captures.push(await decode((await renderer.capture()).blob))
        inspections.push(await Promise.all((await renderer.inspect(['iso-front-right', 'iso-back-left'])).map(image => decode(image.blob))))
        restored()
      }
      check(difference(captures[0], captures[1]).max <= 2, 'Capture bypass must match unculled capture')
      for (let i = 0; i < 2; i++) check(difference(inspections[0][i], inspections[1][i]).max <= 2, 'Independent inspection cameras must match unculled inspection')
      check(secondary.some(frame => frame.capture) && secondary.filter(frame => frame.inspection).length === 4, 'Observe actual capture and independent inspection pipelines')
      compare('live resumes after secondary cameras', 'positive')
      results.push({ name: 'DPR, capture and inspection bypass', secondary, normalDpr: 2, interactiveDpr: 1 })
    } finally {
      if (descriptor) Object.defineProperty(viewport, 'renderRaster', descriptor)
      else Reflect.deleteProperty(viewport, 'renderRaster')
      viewport.controls.dispatchEvent({ type: 'end' })
      Reflect.get(viewport, 'clearRasterInteractions').call(viewport)
    }
    const loss = webgl.getContext().getExtension('WEBGL_lose_context')
    check(loss, 'Context restoration check requires WEBGL_lose_context')
    const previousRaster = Reflect.get(viewport, 'raster')
    loss.loseContext()
    await until(() => Reflect.get(viewport, 'contextLost'), 'occlusion context loss')
    loss.restoreContext()
    await until(() => !Reflect.get(viewport, 'contextLost') && Reflect.get(viewport, 'raster') !== previousRaster, 'occlusion context restore')
    await idle()
    compare('live culling after context restoration', 'positive')
    for (const shape of ['sparse', 'checkerboard'] as const) {
      await load(fixture(shape).document); view()
      compare(`${shape} negative control`, 'zero')
    }
    healthy()
    return { checks: results, parity: 'preserved live canvas RGBA, maximum channel error <= 2', errorsAdded: 0 }
  })
}

export async function runOcclusionBenchmark(renderer: VoxelRenderer, settings: ViewSettings, errors: string[]) {
  return withOcclusionViewport(renderer, settings, errors, async ({ baseline, fixture, load, live, healthy }) => {
    const viewport = renderer.viewport, webgl = viewport.renderer, gl = webgl.getContext()
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const hardware = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    const software = /swiftshader|llvmpipe|softpipe|software|lavapipe|swrast/i.test(hardware)
    const percentile = (values: number[]) => {
      check(values.length > 0 && values.every(Number.isFinite), 'Benchmark samples must be finite and nonempty')
      const sorted = values.toSorted((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
    }
    const results: object[] = []
    renderer.setSettings({ ...baseline, projection: 'perspective' })
    webgl.info.autoReset = false
    for (const shape of ['wall-detail', 'sparse', 'checkerboard'] as const) {
      renderer.occlusionCulling = false
      const { document } = fixture(shape, true)
      check(document.chunks.size >= 32 && document.chunks.size <= 128, 'Benchmark must contain 32-128 populated chunks')
      await load(document)
      renderer.setView({ position: { x: 0, y: 32, z: 130 }, target: { x: 0, y: 32, z: 0 }, fov: 45 })
      renderer.occlusionCulling = true
      const content = viewport.content!, provider = content.cullOpaque
      check(provider, 'Benchmark needs the installed model culler')
      const restored = sourceState(viewport.scene)
      const samples: { enabled: boolean; angle: number; radius: number; mainThreadMs: number; completedFrameMs: number;
        cullMs: number; skippedDraws: number; drawCalls: number; triangles: number; occluders: number; rebuilds: number }[] = []
      try {
        // Keep installed caches for steady-state timing; off only suspends the same live callback.
        // API registration/toggle cost is intentionally outside orbit/zoom frame measurements.
        for (let i = -2; i < 12; i++) {
          const angle = Math.max(0, i) / 12 * Math.PI * 2, radius = 130 + Math.sin(angle * 2) * 30
          viewport.camera.position.set(Math.sin(angle) * radius, 32 + Math.sin(angle) * 18, Math.cos(angle) * radius)
          viewport.camera.lookAt(0, 32, 0)
          viewport.camera.updateMatrixWorld(true)
          for (const enabled of i % 2 === 0 ? [false, true] : [true, false]) {
            content.cullOpaque = enabled ? provider : undefined
            // Diagnostic synchronization only. This is completed frame cost, NOT achieved FPS.
            gl.finish()
            webgl.info.reset()
            const start = performance.now(), frame = live(), submitted = performance.now()
            gl.finish()
            const completed = performance.now()
            if (i >= 0) samples.push({ enabled, angle, radius, mainThreadMs: submitted - start, completedFrameMs: completed - start,
              cullMs: enabled ? frame.culling!.milliseconds : 0, skippedDraws: frame.pipeline.occludedMeshes,
              drawCalls: webgl.info.render.calls, triangles: webgl.info.render.triangles,
              occluders: enabled ? frame.culling!.occluders : 0, rebuilds: enabled ? frame.culling!.rebuilds : 0 })
            restored(); healthy()
          }
          await new Promise(resolve => setTimeout(resolve, 0))
        }
        check(samples.some(sample => sample.enabled && sample.skippedDraws > 0) === (shape === 'wall-detail'), `${shape}: incorrect positive/negative culling control`)
        check(samples.filter(sample => !sample.enabled).every(sample => sample.skippedDraws === 0), 'Disabled benchmark frames must not skip surfaces')
        if (shape === 'wall-detail') check(samples.find(sample => sample.enabled && sample.angle === 0)!.drawCalls
          < samples.find(sample => !sample.enabled && sample.angle === 0)!.drawCalls, 'Positive control must also reduce actual WebGL draw calls')
        results.push({ shape, dimensions: document.dimensions, chunks: document.chunks.size, voxels: document.voxelCount,
          controls: shape === 'checkerboard' ? '4^3 checkerboard pockets in all 64 chunks' : shape,
          modes: [false, true].map(enabled => {
            const mode = samples.filter(sample => sample.enabled === enabled)
            return { enabled, frames: mode.length, mainThreadMs: percentile(mode.map(sample => sample.mainThreadMs)),
              completedFrameMs: percentile(mode.map(sample => sample.completedFrameMs)), cullMs: percentile(mode.map(sample => sample.cullMs)),
              skippedDraws: percentile(mode.map(sample => sample.skippedDraws)), drawCalls: percentile(mode.map(sample => sample.drawCalls)),
              occluders: percentile(mode.map(sample => sample.occluders)), rebuilds: mode.reduce((sum, sample) => sum + sample.rebuilds, 0) }
          }), samples })
      } finally { content.cullOpaque = provider }
    }
    return { hardware, backend: software ? 'software' : debug ? 'native/unrecognized' : 'unknown (renderer masked)', diagnosticOnly: true,
      timing: 'Main-thread live render and gl.finish-synchronized completed frame costs in ms; not FPS or isolated GPU time. No performance pass/fail threshold.',
      workload: '12 paired orbit/zoom views per fixture, two paired warmups, alternating on/off order; steady-state callback bypass excludes API toggle/registration cost.',
      viewport: [webgl.domElement.width, webgl.domElement.height], dpr: webgl.getPixelRatio(), results, errorsAdded: 0 }
  })
}
