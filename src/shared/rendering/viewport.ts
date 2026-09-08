import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import { RasterPipeline } from './raster-pipeline'
import { TiltShift } from './tilt-shift'
import type { ViewSettings } from './settings'
import type { CameraSnapshot, SceneContent, PreparedSceneContent, ViewportCallbacks, Vector3Value as Vec3 } from './contracts'
import { sceneShadowVolume, workspaceGridPositions, workspaceGridPlaneVisible } from './stage'

export class Viewport {
  constructor(host: HTMLElement, settings: ViewSettings, callbacks: ViewportCallbacks = {}) {
    this.host = host
    this.callbacks = callbacks
    this.settings = { ...settings }
    this.camera = this.createCamera(settings.projection)
    this.controls = this.createControls(this.camera)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.environmentTarget = this.createEnvironment()
    this.ambientEnvironment = this.createAmbientEnvironment()
    this.scene.environment = this.ambientEnvironment
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.raster = new RasterPipeline(this.renderer, this.scene, { ambientOcclusion: settings.ambientOcclusion })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('aria-label', '3D viewport. Right drag or two-finger drag orbits.')
    this.host.append(this.renderer.domElement)

    this.scene.add(this.hemisphere, this.sunlight, this.sunlightTarget)
    this.sunlight.castShadow = true
    this.sunlight.target = this.sunlightTarget
    this.sunlight.shadow.mapSize.set(2048, 2048)
    const options = { signal: this.listeners.signal }
    this.renderer.domElement.addEventListener('contextmenu', event => event.preventDefault(), options)
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault()
      this.contextLost = true
      this.pathTracingRevision++
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      if (this.rasterFrame !== undefined) cancelAnimationFrame(this.rasterFrame)
      this.rasterFrame = undefined
      this.disposePathTracer()
      this.tiltShift?.dispose()
      this.tiltShift = undefined
      this.releaseSceneDetail()
      this.callbacks.onPathTracingStatus?.('Graphics context lost')
    }, options)
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
      this.environmentTarget.dispose()
      this.environmentTarget = this.createEnvironment()
      if (this.ground) (this.ground.material as THREE.MeshStandardMaterial).envMap = this.environmentTarget.texture
      this.sceneContent?.onViewportChange()
      this.renderer.shadowMap.needsUpdate = true
      this.pathTracingFailed = false
      this.requestPathTraceRebuild()
      this.render()
    }, options)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.rebuildStage()
    this.frameSceneBounds(this.stageBounds)
    this.resize()
  }

  readonly renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  readonly scene = new THREE.Scene()
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
  controls: OrbitControls
  private raster: RasterPipeline
  private rasterFrame?: number
  private contextLost = false
  private rasterError?: string
  private presentationDirty = true
  private tiltShift?: TiltShift
  private tiltShiftDirty = false
  private environmentTarget: THREE.WebGLRenderTarget
  private ambientEnvironment: THREE.DataTexture
  private grid?: THREE.Group
  private limits?: THREE.Box3Helper
  private ground?: THREE.Mesh
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x8c91a0, 1.2)
  private sunlight = new THREE.DirectionalLight(0xffffff, 2.4)
  private sunlightTarget = new THREE.Object3D()
  settings: ViewSettings
  renderMode = false
  private focusAnimation?: number
  private pathTracer?: WebGLPathTracer
  private pathTracingWorker?: { dispose: () => void }
  private pathTracingRevision = 0
  private pathTracingFrame?: number
  private pathTracingBuildRunning = false
  private pathTracingBuildRequested = false
  private pathTracingReady = false
  private pathTracingFailed = false
  private fpsFrames = 0
  private fpsStarted = performance.now()
  private fpsIdleTimer?: ReturnType<typeof setTimeout>
  private resizeObserver: ResizeObserver
  private orthographicSpan = 32
  private host: HTMLElement
  private sceneContent?: SceneContent
  private fullContent?: PreparedSceneContent
  private fullPreparation?: Promise<PreparedSceneContent>
  private fullAbort?: AbortController
  private fullEpoch = 0
  private fullViewportPixels = 0
  private traceScene?: THREE.Scene
  private traceGround?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  private sceneInteraction = false
  private sceneCameraDirty = false
  private callbacks: ViewportCallbacks
  private listeners = new AbortController()
  private disposed = false
  private emptyBounds = new THREE.Box3(new THREE.Vector3(-16, 0, -16), new THREE.Vector3(16, 32, 16))

  get content() { return this.sceneContent }
  get environment() { return this.environmentTarget.texture }
  private get worldScale() { return this.sceneContent?.stage !== 'bounded' }
  private get stageBounds() { return this.sceneContent?.bounds ?? this.emptyBounds }
  private contentReady() { return this.sceneContent?.isReady?.() !== false }

  private createCamera(projection: ViewSettings['projection']) {
    if (projection === 'perspective') return new THREE.PerspectiveCamera(34, 1, this.worldScale ? 0.5 : 0.1, this.worldScale ? 131072 : 2000)
    return new THREE.OrthographicCamera(-20, 20, 20, -20, this.worldScale ? -65536 : -1000, this.worldScale ? 131072 : 2000)
  }

  private createEnvironment() {
    const room = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    try { return pmrem.fromScene(room, 0.04, 0.1, 100, { size: 64 }) }
    finally { room.dispose(); pmrem.dispose() }
  }

  private createAmbientEnvironment() {
    const width = 64, height = 32
    const pixels = new Float32Array(width * height * 4)
    const color = new THREE.Color()
    for (let y = 0; y < height; y++) {
      color.copy(this.hemisphere.groundColor).lerp(this.hemisphere.color, (1 - Math.cos((y + 0.5) / height * Math.PI)) / 2)
      for (let x = 0; x < width; x++) pixels.set([color.r, color.g, color.b, 1], (y * width + x) * 4)
    }
    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType)
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.needsUpdate = true
    return texture
  }

  private createControls(camera: THREE.Camera) {
    const controls = new OrbitControls(camera, this.renderer.domElement)
    let interacting = false
    let changed = false
    controls.enableDamping = false
    controls.screenSpacePanning = true
    controls.mouseButtons.LEFT = -1 as THREE.MOUSE
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
    controls.touches.ONE = -1 as THREE.TOUCH
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE
    controls.minDistance = 2
    controls.maxDistance = this.worldScale ? 65536 : 1200
    controls.addEventListener('start', () => {
      if (!interacting) { changed = false; this.callbacks.onViewStart?.() }
      interacting = true
      this.cancelFocusAnimation()
    })
    controls.addEventListener('change', () => { if (interacting) changed = true; this.cameraChanged() })
    controls.addEventListener('end', () => {
      const report = interacting && changed
      interacting = false
      changed = false
      if (report) this.callbacks.onViewChange?.(this.getView())
    })
    return controls
  }

  moveFocus(target: THREE.Vector3) {
    this.cancelFocusAnimation()
    const startTarget = this.controls.target.clone()
    const shift = target.clone().sub(startTarget)
    if (shift.lengthSq() < 1e-8) return
    this.callbacks.onViewStart?.()
    const endPosition = this.camera.position.clone().add(shift)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(endPosition)
      this.controls.target.copy(target)
      this.controls.update()
      return
    }
    const startPosition = this.camera.position.clone()
    const started = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / 220)
      const eased = 1 - (1 - progress) ** 3
      this.camera.position.lerpVectors(startPosition, endPosition, eased)
      this.controls.target.lerpVectors(startTarget, target, eased)
      this.controls.update()
      this.render()
      if (progress < 1) this.focusAnimation = requestAnimationFrame(step)
      else this.focusAnimation = undefined
    }
    this.focusAnimation = requestAnimationFrame(step)
  }

  private cancelFocusAnimation() {
    if (this.focusAnimation !== undefined) cancelAnimationFrame(this.focusAnimation)
    this.focusAnimation = undefined
  }

  focusViewport() {
    this.renderer.domElement.focus({ preventScroll: true })
  }

  private pathTracingEnabled() {
    return !!this.sceneContent && (!this.worldScale || !!this.sceneContent.prepareFullDetail) && !this.sceneInteraction && this.renderMode && this.settings.pathTracing && !this.pathTracingFailed && !this.contextLost && !this.disposed
  }

  private stopPathTracingSamples() {
    if (this.pathTracingFrame !== undefined) cancelAnimationFrame(this.pathTracingFrame)
    this.pathTracingFrame = undefined
  }

  private startPathTracingSamples(reset = true) {
    if (!this.pathTracer || !this.pathTracingEnabled() || !this.pathTracingReady) return
    this.stopPathTracingSamples()
    if (reset) { this.pathTracer.reset(); this.presentationDirty = true }
    this.resetFps()
    let reportedSamples = -1
    const sample = () => {
      this.pathTracingFrame = undefined
      if (!this.pathTracer || !this.pathTracingEnabled() || !this.pathTracingReady) return
      try {
        const previousSamples = Math.floor(this.pathTracer.samples)
        this.renderPathTrace()
        const samples = Math.floor(this.pathTracer.samples)
        if (this.pathTracer.samples > 0) this.presentationDirty = false
        if (samples > previousSamples) this.recordFrame(samples - previousSamples)
        if (samples !== reportedSamples) {
          reportedSamples = samples
          this.callbacks.onPathTracingStatus?.(`${samples} ${samples === 1 ? 'sample' : 'samples'}`)
        }
        if (samples < 128) this.pathTracingFrame = requestAnimationFrame(sample)
        else this.resetFps()
      } catch (error) {
        this.failPathTracing(error)
      }
    }
    this.pathTracingFrame = requestAnimationFrame(sample)
  }

  private async ensurePathTracer() {
    if (this.pathTracer) return this.pathTracer
    const [{ WebGLPathTracer }, { GenerateMeshBVHWorker }] = await Promise.all([
      import('three-gpu-pathtracer'),
      import('three-mesh-bvh/worker'),
    ])
    if (!this.pathTracingEnabled()) return undefined
    const tracer = new WebGLPathTracer(this.renderer)
    const worker = new GenerateMeshBVHWorker()
    this.pathTracingWorker = worker
    tracer.setBVHWorker(worker)
    tracer.bounces = 4
    tracer.tiles.set(2, 2)
    tracer.renderScale = this.worldScale ? 0.75 * Math.min(1, Math.sqrt(1_000_000 / (this.renderer.domElement.width * this.renderer.domElement.height))) : 0.75
    tracer.renderDelay = 0
    tracer.minSamples = 1
    tracer.fadeDuration = 180
    tracer.dynamicLowRes = true
    tracer.rasterizeSceneCallback = () => this.renderRaster()
    this.pathTracer = tracer
    return tracer
  }

  requestPathTraceRebuild() {
    if (this.disposed) return
    this.pathTracingRevision++
    this.pathTracingBuildRequested = true
    this.pathTracingReady = false
    this.stopPathTracingSamples()
    this.render()
    if (this.sceneContent && this.worldScale && !this.sceneContent.prepareFullDetail && this.renderMode && this.settings.pathTracing) this.callbacks.onPathTracingStatus?.('Scene raster only (no full-detail adapter)')
    if (!this.pathTracingEnabled()) return
    if (!this.contentReady()) {
      this.callbacks.onPathTracingStatus?.('Updating mesh')
      return
    }
    void this.buildPathTrace()
  }

  /** Resume a deferred build after the content adapter drains its work queue. */
  contentBecameReady() {
    if (this.pathTracingBuildRequested && this.pathTracingEnabled() && this.contentReady()) void this.buildPathTrace()
  }

  private async buildPathTrace() {
    if (this.pathTracingBuildRunning) return
    this.pathTracingBuildRunning = true
    let buildingTracer: WebGLPathTracer | undefined
    let buildingRevision = this.pathTracingRevision
    try {
      while (this.pathTracingEnabled() && this.pathTracingBuildRequested && this.contentReady()) {
        const revision = this.pathTracingRevision
        buildingRevision = revision
        this.pathTracingBuildRequested = false
        const content = this.sceneContent
        let prepared: PreparedSceneContent | undefined
        if (content && this.worldScale) {
          this.callbacks.onPathTracingStatus?.('Preparing full scene')
          prepared = await this.prepareSceneContent()
          if (!this.pathTracingEnabled() || content !== this.sceneContent) break
          if (revision !== this.pathTracingRevision) { this.pathTracingBuildRequested = true; continue }
          // A fresh generator avoids retaining a previous expanded scene during a rebuild.
          this.disposePathTracer()
        }
        const tracer = await this.ensurePathTracer()
        buildingTracer = tracer
        if (!tracer || !this.pathTracingEnabled()) break
        if (revision !== this.pathTracingRevision || !this.contentReady()) {
          this.pathTracingBuildRequested = true
          continue
        }
        let progressStep = -1
        this.callbacks.onPathTracingStatus?.('Preparing')
        const traceScene = prepared ? this.createTraceScene(prepared) : this.scene
        await tracer.setSceneAsync(traceScene, this.camera, {
          onProgress: progress => {
            if (!this.pathTracingEnabled() || revision !== this.pathTracingRevision) return
            const step = Math.floor(progress * 10)
            if (step !== progressStep) {
              progressStep = step
              this.callbacks.onPathTracingStatus?.(`Preparing ${Math.round(progress * 100)}%`)
            }
          },
        })
        this.pathTracingReady = this.pathTracingEnabled() && revision === this.pathTracingRevision
          && !this.pathTracingBuildRequested && this.contentReady()
        if (this.pathTracingReady) this.sceneCameraDirty = false
      }
    } catch (error) {
      if (!this.contextLost && (!buildingTracer || buildingTracer === this.pathTracer) && buildingRevision === this.pathTracingRevision && this.pathTracingEnabled()) this.failPathTracing(error)
    } finally {
      this.pathTracingBuildRunning = false
    }
    if (this.pathTracingEnabled() && this.pathTracingBuildRequested && this.contentReady()) void this.buildPathTrace()
    else if (this.pathTracingEnabled() && this.pathTracingReady && !this.pathTracingBuildRequested && this.contentReady()) this.startPathTracingSamples()
  }

  private disposePathTracer() {
    this.pathTracingWorker?.dispose()
    this.pathTracingWorker = undefined
    this.pathTracer?.dispose()
    this.pathTracer = undefined
    this.traceScene?.clear()
    this.traceScene = undefined
    this.traceGround?.geometry.dispose()
    this.traceGround?.material.dispose()
    this.traceGround = undefined
  }

  private failPathTracing(error: unknown) {
    // GL reports loss before the DOM event is delivered. Let restoration own
    // recovery rather than reporting a transient device loss as a tracer failure.
    if (this.contextLost || this.renderer.getContext().isContextLost()) {
      this.contextLost = true
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      return
    }
    this.pathTracingFailed = true
    this.pathTracingReady = false
    this.pathTracingBuildRequested = true
    this.pathTracingRevision++
    this.stopPathTracingSamples()
    this.disposePathTracer()
    if (this.sceneContent) this.releaseSceneDetail()
    this.resetFps()
    this.callbacks.onPathTracingStatus?.('Raster fallback')
    this.callbacks.onError?.(`Progressive PBR stopped. Using the realtime renderer. ${error instanceof Error ? error.message : ''}`.trim())
    this.render()
  }

  updatePathTracing(...changes: ('materials' | 'lights' | 'environment' | 'camera')[]) {
    if (!this.pathTracingEnabled()) return
    if (!this.pathTracer || !this.pathTracingReady || this.pathTracingBuildRunning || !this.contentReady()) {
      this.requestPathTraceRebuild()
      return
    }
    try {
      for (const change of changes) {
        if (change === 'materials') this.pathTracer.updateMaterials()
        else if (change === 'lights') this.pathTracer.updateLights()
        else if (change === 'environment') this.pathTracer.updateEnvironment()
        else this.pathTracer.setCamera(this.camera)
      }
      if (changes.includes('camera')) this.sceneCameraDirty = false
      this.startPathTracingSamples()
    } catch (error) { this.failPathTracing(error) }
  }

  private cameraChanged() {
    if (this.worldScale) this.sceneCameraDirty = true
    if (this.worldScale && this.camera instanceof THREE.PerspectiveCamera) {
      // Scene-scale depth precision without sacrificing close-up voxel editing.
      this.camera.near = Math.max(0.1, this.controls.getDistance() / 1000)
      this.camera.updateProjectionMatrix()
    }
    this.updateWorkspaceGridVisibility()
    this.sceneContent?.onViewportChange()
    if (this.pathTracer && this.pathTracingReady && !this.pathTracingBuildRunning) this.updatePathTracing('camera')
    this.render()
  }

  setRenderMode(enabled: boolean) {
    if (this.renderMode === enabled) return
    this.renderMode = enabled
    this.updateWorkspaceGridVisibility()
    if (this.limits) this.limits.visible = this.settings.grid && !enabled
    if (this.ground) this.ground.visible = enabled
    this.sceneContent?.onViewportChange()
    if (enabled && this.settings.pathTracing) {
      this.pathTracingFailed = false
      if (this.worldScale && this.pathTracingReady && !this.pathTracingBuildRequested) {
        if (this.sceneCameraDirty) this.updatePathTracing('camera')
        else this.startPathTracingSamples(false)
      } else this.requestPathTraceRebuild()
    } else {
      this.pathTracingRevision++
      this.resetFps()
      if (!this.worldScale) this.pathTracingReady = false
      else if (this.pathTracingBuildRunning || this.fullPreparation) this.invalidateSceneContent()
      this.stopPathTracingSamples()
      this.callbacks.onPathTracingStatus?.('Ready')
      this.render()
    }
  }

  setSettings(settings: ViewSettings) {
    const previous = this.settings
    this.tiltShiftDirty ||= (['tiltShift', 'tiltShiftStrength', 'tiltShiftFocus', 'tiltShiftWidth'] as const).some(key => settings[key] !== previous[key])
    const projectionChanged = settings.projection !== this.settings.projection
    const pathTracingChanged = settings.pathTracing !== this.settings.pathTracing
    const sceneDependenciesChanged = this.worldScale && (['background', 'ambient', 'light', 'lightAzimuth', 'shadows'] as const).some(key => settings[key] !== previous[key])
    this.settings = { ...settings }
    const background = new THREE.Color(settings.background)
    this.scene.background = background
    this.hemisphere.intensity = settings.ambient
    this.scene.environmentIntensity = settings.ambient / Math.PI
    this.sunlight.intensity = settings.light
    this.raster.ambientOcclusion.enabled = settings.ambientOcclusion
    this.renderer.shadowMap.enabled = settings.shadows
    this.updateWorkspaceGridVisibility()
    if (this.limits) this.limits.visible = settings.grid && !this.renderMode
    if (this.ground) {
      this.ground.visible = this.renderMode
      ;(this.ground.material as THREE.MeshStandardMaterial).color.set(settings.background).offsetHSL(0, -0.04, -0.035)
      ;(this.ground.material as THREE.Material).needsUpdate = true
    }
    const stageSize = this.stageBounds.getSize(new THREE.Vector3())
    const center = this.stageBounds.getCenter(new THREE.Vector3())
    if (!this.worldScale) center.y = this.stageBounds.min.y
    const radius = Math.max(this.worldScale ? 32 : 0, stageSize.x, stageSize.y, stageSize.z)
    const radians = THREE.MathUtils.degToRad(settings.lightAzimuth)
    this.sunlight.position.set(Math.cos(radians) * radius, radius * 1.7, Math.sin(radians) * radius).add(center)
    if (settings.shadows !== previous.shadows || settings.lightAzimuth !== previous.lightAzimuth) this.renderer.shadowMap.needsUpdate = true
    this.fitShadowCamera()
    if (projectionChanged) this.switchProjection(settings.projection)
    this.sceneContent?.onViewportChange()
    if (pathTracingChanged && settings.pathTracing) this.pathTracingFailed = false
    if (pathTracingChanged) this.resetFps()
    if (sceneDependenciesChanged) this.invalidateSceneContent()
    else if (pathTracingChanged && this.pathTracingEnabled()) this.requestPathTraceRebuild()
    else if (!this.pathTracingEnabled()) {
      if (pathTracingChanged) this.pathTracingRevision++
      this.pathTracingReady = false
      this.stopPathTracingSamples()
      this.callbacks.onPathTracingStatus?.(this.worldScale && this.renderMode && settings.pathTracing ? 'Scene raster fallback' : 'Ready')
    } else {
      const changes: ('materials' | 'lights' | 'environment' | 'camera')[] = []
      if (settings.background !== previous.background || settings.shadows !== previous.shadows) changes.push('materials')
      if (settings.background !== previous.background || settings.ambient !== previous.ambient) changes.push('environment')
      if (settings.light !== previous.light || settings.lightAzimuth !== previous.lightAzimuth) changes.push('lights')
      if (projectionChanged) changes.push('camera')
      if (changes.length) this.updatePathTracing(...changes)
    }
    this.render()
  }

  private updateWorkspaceGridVisibility() {
    if (!this.grid) return
    this.grid.visible = this.settings.grid && !this.renderMode
    if (!this.grid.visible) return
    if (this.worldScale) return
    const dimensions = this.stageBounds.getSize(new THREE.Vector3())
    const center = this.stageBounds.getCenter(new THREE.Vector3())
    const camera = this.camera.position.clone().sub(center)
    for (const child of this.grid.children) child.visible = workspaceGridPlaneVisible(dimensions, child.userData.normal as Vec3, camera)
  }

  private switchProjection(projection: ViewSettings['projection']) {
    this.cancelFocusAnimation()
    const position = this.camera.position.clone()
    const target = this.controls.target.clone()
    this.controls.dispose()
    this.camera = this.createCamera(projection)
    this.camera.position.copy(position)
    this.controls = this.createControls(this.camera)
    this.controls.target.copy(this.sceneContent?.focusTarget?.() ?? target)
    this.controls.update()
    this.resize()
  }

  private rebuildStage() {
    if (this.grid) {
      this.scene.remove(this.grid)
      for (const child of this.grid.children) {
        const lines = child as THREE.LineSegments
        lines.geometry.dispose()
        ;(lines.material as THREE.Material).dispose()
      }
    }
    if (this.limits) {
      this.scene.remove(this.limits)
      this.limits.geometry.dispose()
      ;(this.limits.material as THREE.Material).dispose()
    }
    if (this.ground) { this.scene.remove(this.ground); this.ground.geometry.dispose(); (this.ground.material as THREE.Material).dispose() }
    const sceneBounds = this.stageBounds
    const stageSize = sceneBounds.getSize(new THREE.Vector3())
    const center = sceneBounds.getCenter(new THREE.Vector3())
    const size = Math.max(32, stageSize.x, stageSize.z)
    this.grid = new THREE.Group()
    const gridNormals: Vec3[] = [
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ]
    for (const normal of this.worldScale ? [] : gridNormals) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(workspaceGridPositions(stageSize, normal), 3))
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xb8c3ca, transparent: true, opacity: 0.58 }))
      lines.position.set(center.x - normal.x * 0.002, sceneBounds.min.y - normal.y * 0.002, center.z - normal.z * 0.002)
      lines.userData.normal = normal
      this.grid.add(lines)
    }
    if (this.worldScale) {
      const spacing = Math.max(1, 2 ** Math.ceil(Math.log2(size / 64)))
      const grid = new THREE.GridHelper(Math.ceil(size / spacing) * spacing, Math.ceil(size / spacing), 0x7b8993, 0xb8c3ca)
      grid.position.set(center.x, sceneBounds.min.y, center.z)
      this.grid.add(grid)
    }
    this.limits = new THREE.Box3Helper(sceneBounds.clone(), 0x7b8993)
    const limitsMaterial = this.limits.material as THREE.LineBasicMaterial
    limitsMaterial.transparent = true
    limitsMaterial.opacity = 0.68
    limitsMaterial.depthWrite = false
    this.limits.visible = this.settings.grid && !this.renderMode
    this.scene.add(this.grid, this.limits)
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 2, size * 2),
      new THREE.MeshStandardMaterial({ color: this.settings.background, roughness: 1, envMap: this.environmentTarget.texture, envMapIntensity: 0 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.position.set(center.x, sceneBounds.min.y - 0.03, center.z)
    this.ground.receiveShadow = true
    this.ground.visible = this.renderMode
    this.scene.add(this.ground)
    this.sunlightTarget.position.copy(this.worldScale ? center : new THREE.Vector3(center.x, sceneBounds.min.y + stageSize.y / 3, center.z))
    this.setSettings(this.settings)
  }

  private fitShadowCamera() {
    this.sunlight.updateMatrixWorld(true)
    this.sunlightTarget.updateMatrixWorld(true)
    this.sunlight.shadow.updateMatrices(this.sunlight)
    const camera = this.sunlight.shadow.camera
    const { x, y, z } = this.stageBounds.getSize(new THREE.Vector3())
    const size = Math.max(32, x, z)
    const center = this.stageBounds.getCenter(new THREE.Vector3()).setY(this.stageBounds.min.y)
    const bounds = (this.worldScale ? this.stageBounds.clone() : new THREE.Box3(new THREE.Vector3(-size, -0.03, -size), new THREE.Vector3(size, y, size)).translate(center)).applyMatrix4(camera.matrixWorldInverse)
    const values = [bounds.min.x - 1, bounds.max.x + 1, bounds.max.y + 1, bounds.min.y - 1, Math.max(0.1, -bounds.max.z - 1), -bounds.min.z + 1]
    if (values.some((value, index) => value !== [camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far][index])) this.renderer.shadowMap.needsUpdate = true
    ;[camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far] = values
    camera.updateProjectionMatrix()
  }

  /** Live references: reacquire after projection/context changes. Do not dispose them. */
  getSceneViewport() {
    return { renderer: this.renderer, scene: this.scene, camera: this.camera,
      canvas: this.renderer.domElement, environment: this.environmentTarget.texture,
      controls: this.controls, renderMode: this.renderMode, shadows: this.settings.shadows }
  }

  /** Receiver-scoped shadow residency only; the shared shadow map keeps its existing
   * scene-wide fit. Include the PCF footprint so filtered edge shadows are retained. */
  getSceneShadowVolume(receivers: Iterable<THREE.Box3>, occupied: THREE.Box3) {
    if (!this.settings.shadows) return
    const shadow = this.sunlight.shadow, camera = shadow.camera
    const texel = Math.max((camera.right - camera.left) / shadow.mapSize.x, (camera.top - camera.bottom) / shadow.mapSize.y)
    let groundBounds: THREE.Box3 | undefined
    if (this.ground?.visible) {
      this.ground.updateWorldMatrix(true, false)
      this.ground.geometry.computeBoundingBox()
      groundBounds = this.ground.geometry.boundingBox!.clone().applyMatrix4(this.ground.matrixWorld)
    }
    return sceneShadowVolume(this.camera, occupied, receivers, camera.matrixWorldInverse,
      this.ground?.visible ? this.ground.position.y : undefined, texel * (Math.abs(shadow.radius) + 1) + Math.abs(shadow.normalBias), groundBounds)
  }

  /** Borrow one content root. Adapters own activation, input hooks and saved views. */
  setSceneContent(content?: SceneContent) {
    if (this.disposed) throw new Error('Viewport is disposed')
    const previous = this.sceneContent
    if (!previous && !content) return
    if (previous !== content) { this.disposePathTracer(); this.releaseSceneDetail(); this.pathTracingFailed = false }
    this.sceneContent = content
    this.cancelFocusAnimation()
    this.sceneInteraction = false
    if (previous && previous !== content) this.scene.remove(previous.root)
    if (content) this.scene.add(content.root)
    this.controls.enabled = true
    this.controls.touches.ONE = -1 as THREE.TOUCH
    this.controls.maxDistance = this.worldScale ? 65536 : 1200
    this.camera.near = this.camera instanceof THREE.PerspectiveCamera ? this.worldScale ? 0.5 : 0.1 : this.worldScale ? -65536 : -1000
    this.camera.far = this.worldScale ? 131072 : 2000
    this.camera.updateProjectionMatrix()
    this.renderer.domElement.setAttribute('aria-label', content?.label ?? '3D viewport. Right drag or two-finger drag orbits.')
    this.rebuildStage()
    this.renderer.shadowMap.needsUpdate = true
    this.requestPathTraceRebuild()
  }

  /** Only committed scene dependencies call this. Streaming and selection never do. */
  invalidateSceneContent() {
    if (!this.sceneContent) return
    this.disposePathTracer()
    this.releaseSceneDetail()
    this.pathTracingFailed = false
    this.requestPathTraceRebuild()
  }

  setSceneInteraction(active: boolean) {
    if (this.sceneInteraction === active) return
    this.sceneInteraction = active
    if (active) { this.stopPathTracingSamples(); this.render() }
    else if (this.pathTracingReady && this.pathTracingEnabled()) this.startPathTracingSamples(false)
  }

  private releaseSceneDetail() {
    this.fullEpoch++
    this.fullAbort?.abort()
    this.fullAbort = undefined
    this.fullPreparation = undefined
    this.fullContent?.dispose()
    this.fullContent = undefined
  }

  private prepareSceneContent(): Promise<PreparedSceneContent> {
    if (this.fullContent) return Promise.resolve(this.fullContent)
    if (this.fullPreparation) return this.fullPreparation
    const content = this.sceneContent
    if (!content?.prepareFullDetail) return Promise.reject(new Error('This scene adapter cannot provide exact full-scene content.'))
    const controller = new AbortController(), epoch = this.fullEpoch
    this.fullAbort = controller
    this.fullViewportPixels = this.renderer.domElement.width * this.renderer.domElement.height
    const promise = content.prepareFullDetail(controller.signal).then(prepared => {
      if (controller.signal.aborted || epoch !== this.fullEpoch || content !== this.sceneContent) {
        prepared.dispose(); throw new DOMException('Full-scene preparation was superseded', 'AbortError')
      }
      // Defense at the tracer boundary: never accidentally accept an instanced adapter.
      try {
        if (prepared.scope !== 'full-scene' || !Number.isSafeInteger(prepared.triangles) || prepared.triangles > 1_000_000 || !Number.isFinite(prepared.peakBytes) || prepared.peakBytes > 96 * 1024 * 1024) throw new Error('Full-scene adapter exceeded its declared budget.')
        const materials = new Set<THREE.Material>()
        let triangles = 2
        prepared.root.traverse(object => {
          if ((object as THREE.InstancedMesh).isInstancedMesh || (object as THREE.BatchedMesh).isBatchedMesh) throw new Error('The tracer requires ordinary expanded meshes, not instancing.')
          if (object instanceof THREE.Mesh) {
            triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3
            for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
          }
        })
        if (triangles > prepared.triangles || materials.size > 65534) throw new Error('Full-scene adapter understated its triangle/material count.')
      } catch (error) { prepared.dispose(); throw error }
      this.fullContent = prepared
      return prepared
    }).finally(() => { if (this.fullPreparation === promise) this.fullPreparation = undefined })
    this.fullPreparation = promise
    return promise
  }

  private createTraceScene(prepared: PreparedSceneContent) {
    const scene = new THREE.Scene()
    scene.background = this.scene.background
    scene.environment = this.scene.environment
    scene.environmentIntensity = this.scene.environmentIntensity
    scene.backgroundIntensity = this.scene.backgroundIntensity
    scene.add(prepared.root)
    const light = this.sunlight.clone()
    light.target = this.sunlightTarget.clone()
    scene.add(light, light.target)
    if (this.ground?.visible) {
      const source = this.ground as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      const ground = new THREE.Mesh(source.geometry.clone(), source.material.clone())
      ground.material.envMap = null
      Object.assign(ground.material, { castShadow: this.settings.shadows })
      ground.position.copy(source.position); ground.quaternion.copy(source.quaternion); ground.scale.copy(source.scale)
      ground.receiveShadow = true
      scene.add(ground); this.traceGround = ground
    }
    this.traceScene = scene
    return scene
  }

  frameSceneBounds(bounds: THREE.Box3) {
    if (bounds.isEmpty()) return
    this.cancelFocusAnimation()
    const center = bounds.getCenter(new THREE.Vector3())
    const size = Math.max(8, bounds.getSize(new THREE.Vector3()).length())
    const aspect = Math.max(0.1, this.host.clientWidth / Math.max(1, this.host.clientHeight))
    const fit = 1 / Math.min(1, aspect)
    const direction = this.camera.position.clone().sub(this.controls.target).normalize()
    if (!direction.lengthSq()) direction.set(1, 0.78, 1).normalize()
    this.setView({ position: center.clone().addScaledVector(direction, size * 2 * fit), target: center, orthographicSpan: size * 1.3 * fit, zoom: 1 })
  }

  frameLocalBounds(center: THREE.Vector3, size: number) {
    const direction = new THREE.Vector3(1, 0.78, 1).normalize()
    this.setView({ position: center.clone().addScaledVector(direction, size * 2.6), target: center, orthographicSpan: size * 1.65, zoom: 1 })
  }

  getView(): CameraSnapshot {
    return {
      projection: this.camera instanceof THREE.PerspectiveCamera ? 'perspective' : 'orthographic',
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      target: { x: this.controls.target.x, y: this.controls.target.y, z: this.controls.target.z },
      up: { x: this.camera.up.x, y: this.camera.up.y, z: this.camera.up.z },
      zoom: this.camera instanceof THREE.OrthographicCamera ? this.camera.zoom : undefined,
      fov: this.camera instanceof THREE.PerspectiveCamera ? this.camera.fov : undefined,
      orthographicSpan: this.orthographicSpan,
      viewport: { width: this.renderer.domElement.width, height: this.renderer.domElement.height },
    }
  }

  setView(view: Pick<CameraSnapshot, 'position' | 'target'> & Partial<Pick<CameraSnapshot, 'up' | 'zoom' | 'fov' | 'orthographicSpan'>>) {
    this.cancelFocusAnimation()
    this.camera.position.set(view.position.x, view.position.y, view.position.z)
    this.controls.target.set(view.target.x, view.target.y, view.target.z)
    if (view.up) this.camera.up.set(view.up.x, view.up.y, view.up.z)
    if (view.orthographicSpan !== undefined) this.orthographicSpan = view.orthographicSpan
    if (this.camera instanceof THREE.OrthographicCamera && view.zoom !== undefined) this.camera.zoom = view.zoom
    if (this.camera instanceof THREE.PerspectiveCamera && view.fov !== undefined) this.camera.fov = view.fov
    this.resize()
    this.controls.update()
    this.render()
  }

  resize() {
    if (this.disposed) return
    const width = Math.max(1, this.host.clientWidth)
    const height = Math.max(1, this.host.clientHeight)
    const aspect = width / height
    const pixelRatio = Math.min(devicePixelRatio, 2)
    const size = this.renderer.getSize(new THREE.Vector2())
    if (this.renderer.getPixelRatio() !== pixelRatio) this.renderer.setPixelRatio(pixelRatio)
    if (size.x !== width || size.y !== height) this.renderer.setSize(width, height, false)
    if (this.camera instanceof THREE.PerspectiveCamera) this.camera.aspect = aspect
    else {
      this.camera.left = -this.orthographicSpan * aspect / 2
      this.camera.right = this.orthographicSpan * aspect / 2
      this.camera.top = this.orthographicSpan / 2
      this.camera.bottom = -this.orthographicSpan / 2
    }
    this.camera.updateProjectionMatrix()
    this.renderer.getDrawingBufferSize(size)
    this.raster.setSize(size.x, size.y)
    if (this.sceneContent && (this.fullContent || this.fullPreparation) && this.fullViewportPixels !== size.x * size.y) this.invalidateSceneContent()
    this.cameraChanged()
  }

  private resetFps() {
    if (this.fpsIdleTimer) clearTimeout(this.fpsIdleTimer)
    this.fpsFrames = 0
    this.fpsStarted = performance.now()
    this.callbacks.onFps?.()
  }

  private recordFrame(frames = 1) {
    const now = performance.now()
    this.fpsFrames += frames
    const elapsed = now - this.fpsStarted
    if (elapsed < 500) return
    const fps = this.fpsFrames * 1000 / elapsed
    this.callbacks.onFps?.(fps >= 10 ? Math.round(fps) : Number(fps.toFixed(fps < 1 ? 2 : 1)))
    this.fpsFrames = 0
    this.fpsStarted = now
    if (this.pathTracingEnabled()) return
    if (this.fpsIdleTimer) clearTimeout(this.fpsIdleTimer)
    this.fpsIdleTimer = setTimeout(() => {
      this.fpsFrames = 0
      this.fpsStarted = performance.now()
      this.callbacks.onFps?.()
    }, 750)
  }

  private renderRaster(camera = this.camera, raster = this.raster, shadows = !this.pathTracingEnabled()) {
    if (this.contextLost) return
    // FXAA washes out pixel-wide triangle edges; keep the topology inspection view sharp.
    if (raster === this.raster) raster.antialias = !this.settings.meshTriangles || this.renderMode || this.worldScale
    const shadowMap = this.renderer.shadowMap
    const enabled = shadowMap.enabled, needsUpdate = shadowMap.needsUpdate, castShadow = this.sunlight.castShadow
    // Light shadow counts also switch shaders, preventing cached-map sampling in trace previews.
    shadowMap.enabled = this.sunlight.castShadow = this.settings.shadows && shadows
    try { raster.render(camera) }
    finally {
      if (!shadowMap.enabled) shadowMap.needsUpdate = needsUpdate
      shadowMap.enabled = enabled
      this.sunlight.castShadow = castShadow
    }
    this.rasterError = undefined
    if (raster === this.raster) {
      this.presentationDirty = false
      if (!this.pathTracingEnabled()) this.recordFrame()
    }
  }

  private applyTiltShift() {
    if (this.renderMode && this.settings.tiltShift && this.settings.tiltShiftStrength > 0) {
      this.tiltShift ??= new TiltShift()
      this.tiltShift.render(this.renderer, this.settings)
    }
    this.tiltShiftDirty = false
  }

  private renderPathTrace(pause = false) {
    const tracer = this.pathTracer!
    const paused = tracer.pausePathTracing
    try {
      if (pause) tracer.pausePathTracing = true
      tracer.renderSample()
      this.applyTiltShift()
      if (pause || tracer.samples > 0) this.presentationDirty = false
    } finally { tracer.pausePathTracing = paused }
  }

  render() {
    if (this.disposed || this.contextLost) return
    const traced = this.pathTracingEnabled() && this.pathTracingReady
    if (traced && !this.tiltShiftDirty) return
    if (!traced) this.presentationDirty = true
    if (this.rasterFrame !== undefined) return
    this.rasterFrame = requestAnimationFrame(() => {
      this.rasterFrame = undefined
      if (this.disposed || this.contextLost) return
      const traced = this.pathTracingEnabled() && this.pathTracingReady
      if (traced && !this.tiltShiftDirty) return
      try {
        if (traced && !this.presentationDirty) this.renderPathTrace(true)
        else { this.renderRaster(); this.applyTiltShift() }
      }
      catch (error) {
        if (this.renderer.getContext().isContextLost()) return
        const message = error instanceof Error ? error.message : 'Realtime rendering failed.'
        if (message !== this.rasterError) this.callbacks.onError?.(message)
        this.rasterError = message
      }
    })
  }

  /** exact=true is a full-scene LOD-1 raster capture with all shadow contributors.
   * The bounded adapter rejects oversized/missing dependencies; no partial PNG is returned. */
  async capture(exact = false) {
    if (this.disposed) throw new Error('Viewport is disposed')
    const content = this.sceneContent
    const viewBefore = exact ? JSON.stringify(this.getView()) : undefined
    const epoch = this.fullEpoch
    const prepared = exact && content && this.worldScale ? await this.prepareSceneContent() : undefined
    if (!prepared) await content?.whenReady()
    if (this.disposed || content !== this.sceneContent) throw new Error('Viewport changed during capture. Try again.')
    if (exact && (epoch !== this.fullEpoch || viewBefore !== JSON.stringify(this.getView()))) throw new Error('Scene or camera changed during exact capture. Try again.')
    if (this.contextLost || this.renderer.getContext().isContextLost()) throw new Error('Cannot capture while the graphics context is lost.')
    if (this.rasterFrame !== undefined) cancelAnimationFrame(this.rasterFrame)
    this.rasterFrame = undefined
    const overlays: THREE.Object3D[] = []
    if (content && this.worldScale) {
      for (const object of [this.grid, this.limits]) if (object?.visible) overlays.push(object)
      content.root.traverse(object => { if (object.visible && object.userData.editorOverlay) overlays.push(object) })
    }
    const parent = prepared?.root.parent
    const contentVisible = content?.root.visible
    const environments = new Map<THREE.MeshStandardMaterial, THREE.Texture | null>()
    try {
      for (const object of overlays) object.visible = false
      if (prepared && content) {
        content.root.visible = false
        prepared.root.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material instanceof THREE.MeshStandardMaterial && !environments.has(material)) {
            environments.set(material, material.envMap)
            material.envMap = this.environmentTarget.texture; material.needsUpdate = true
          }
        })
        this.scene.add(prepared.root)
        this.renderer.shadowMap.needsUpdate = true
      }
      if (prepared || this.presentationDirty || !this.pathTracingEnabled() || !this.pathTracingReady) {
        this.renderRaster(this.camera, this.raster, !!prepared || !this.pathTracingEnabled())
        this.applyTiltShift()
      } else if (this.tiltShiftDirty) this.renderPathTrace(true)
    } finally {
      if (prepared && content) {
        this.scene.remove(prepared.root); parent?.add(prepared.root)
        content.root.visible = contentVisible!
        this.renderer.shadowMap.needsUpdate = true
        for (const [material, environment] of environments) { material.envMap = environment; material.needsUpdate = true }
      }
      for (const object of overlays) object.visible = true
      if (overlays.length) this.render()
    }
    const view = this.getView()
    try {
      const blob = await new Promise<Blob>((resolve, reject) => this.renderer.domElement.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not capture the viewport.')), 'image/png'))
      return { blob, view }
    } finally {
      if (prepared && content === this.sceneContent && epoch === this.fullEpoch && this.pathTracingEnabled() && this.pathTracingReady && this.pathTracer) {
        // Restore the trace even when PNG encoding fails, without consuming a sample.
        this.renderPathTrace(true)
      }
    }
  }

  /** Synchronous offscreen raster views; never changes the live camera or canvas size. */
  renderViews(box: THREE.Box3, directions: readonly THREE.Vector3[]) {
    if (this.disposed || this.contextLost || this.renderer.getContext().isContextLost()) throw new Error('Viewport is unavailable for inspection')
    const center = box.getCenter(new THREE.Vector3())
    const distance = box.getSize(new THREE.Vector3()).length() + 1
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, distance * 3)
    const raster = new RasterPipeline(this.renderer, this.scene, { ambientOcclusion: this.settings.ambientOcclusion })
    const visibility = new Map<THREE.Object3D, boolean>()
    const target = this.renderer.getRenderTarget()
    const viewport = this.renderer.getViewport(new THREE.Vector4())
    const scissor = this.renderer.getScissor(new THREE.Vector4())
    const scissorTest = this.renderer.getScissorTest()
    try {
      raster.setSize(512, 512)
      raster.renderToScreen = false
      // No await while scene visibility is overridden.
      for (const object of [this.grid, this.limits, this.ground]) if (object) visibility.set(object, object.visible)
      this.sceneContent?.root.traverse(object => {
        if (object.userData.editorOverlay || object instanceof THREE.Line || object instanceof THREE.Points) visibility.set(object, object.visible)
      })
      for (const object of visibility.keys()) object.visible = false
      return directions.map(direction => {
        camera.position.copy(center).add(direction.clone().normalize().multiplyScalar(distance))
        camera.lookAt(center)
        camera.updateMatrixWorld(true)
        let extent = 0
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
          const point = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse)
          extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y))
        }
        extent = Math.max(1, extent * 1.1)
        camera.left = camera.bottom = -extent
        camera.right = camera.top = extent
        camera.updateProjectionMatrix()
        this.renderRaster(camera, raster, true)
        const pixels = new Uint16Array(512 * 512 * 4)
        this.renderer.readRenderTargetPixels(raster.readBuffer, 0, 0, 512, 512, pixels)
        const rgba = new Uint8ClampedArray(pixels.length)
        for (let y = 0; y < 512; y++) for (let x = 0; x < 2048; x++) rgba[(511 - y) * 2048 + x] = Math.round(THREE.DataUtils.fromHalfFloat(pixels[y * 2048 + x]) * 255)
        const canvas = new OffscreenCanvas(512, 512)
        canvas.getContext('2d')!.putImageData(new ImageData(rgba, 512, 512), 0, 0)
        return canvas
      })
    } finally {
      for (const [object, visible] of visibility) object.visible = visible
      this.renderer.setRenderTarget(target)
      this.renderer.setViewport(viewport)
      this.renderer.setScissor(scissor)
      this.renderer.setScissorTest(scissorTest)
      raster.dispose()
    }
  }

  /** Detach borrowed content without disposing its resources. Dispose adapters first. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.pathTracingRevision++
    this.pathTracingReady = false
    this.listeners.abort()
    this.resizeObserver.disconnect()
    this.cancelFocusAnimation()
    this.stopPathTracingSamples()
    if (this.rasterFrame !== undefined) cancelAnimationFrame(this.rasterFrame)
    this.rasterFrame = undefined
    this.resetFps()
    this.disposePathTracer()
    this.releaseSceneDetail()
    this.controls.dispose()
    this.raster.dispose()
    this.tiltShift?.dispose()
    for (const object of [this.grid, this.limits, this.ground]) object?.traverse(child => {
      if (!(child instanceof THREE.Mesh || child instanceof THREE.Line)) return
      child.geometry.dispose()
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose()
    })
    this.sunlight.shadow.dispose()
    this.environmentTarget.dispose()
    this.ambientEnvironment.dispose()
    this.scene.clear()
    this.sceneContent = undefined
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
