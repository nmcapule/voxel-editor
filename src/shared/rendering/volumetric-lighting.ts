import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

export interface VolumetricLightingConfig {
  bounds: THREE.Box3
  /** Neutral extinction/scattering coefficient per world unit. */
  density: number
  /** Linear scattering tint; defaults to white without changing extinction. */
  color?: THREE.Color
  light: THREE.DirectionalLight
  /** Linear ambient radiance, including its intensity. */
  ambient: THREE.Color
}

/** Camera-independent padding; default optical depth is 0.4 across the longest padded axis. */
export function volumetricRegion(contentBounds: THREE.Box3, fogDensity = 1, fogSpread = 0.25): { bounds: THREE.Box3; density: number } {
  if (!Number.isFinite(fogDensity) || fogDensity < 0 || fogDensity > 3) throw new Error('Volumetric lighting requires finite fog density in 0..3.')
  if (!Number.isFinite(fogSpread) || fogSpread < 0 || fogSpread > 1) throw new Error('Volumetric lighting requires finite fog spread in 0..1.')
  const bounds = contentBounds.clone()
  if (bounds.isEmpty()) return { bounds, density: 0 }
  if (![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error('Volumetric lighting requires finite bounds.')
  const size = bounds.getSize(new THREE.Vector3())
  const longest = Math.max(size.x, size.y, size.z)
  const padding = (longest || 1) * fogSpread
  bounds.expandByScalar(padding)
  return { bounds, density: 0.4 * fogDensity / (longest + padding * 2 || 1) }
}

const vertexShader = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

/** Pipeline-local linear HDR passes. The caller owns render-state restoration and input textures.
 * ponytail: finite conventional perspective/orthographic depth only (including negative ortho near).
 * Glass gets the opaque ray's atmosphere after peeling, not refracted/per-layer transport;
 * use the path tracer for multiple scattering, colored glass shadows and bent light paths.
 */
export class VolumetricLighting {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
  private readonly scattering = new THREE.ShaderMaterial({
    name: 'VolumetricScattering', vertexShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    defines: { VOLUMETRIC_SHADOW: 0 },
    uniforms: {
      opaqueDepth: { value: null },
      projectionInverse: { value: new THREE.Matrix4() },
      cameraWorld: { value: new THREE.Matrix4() },
      boundsMin: { value: new THREE.Vector3() },
      boundsMax: { value: new THREE.Vector3() },
      density: { value: 0 },
      fogColor: { value: new THREE.Color(0xffffff) },
      sunDirection: { value: new THREE.Vector3() },
      sunRadiance: { value: new THREE.Color() },
      ambientRadiance: { value: new THREE.Color() },
      sunShadow: { value: null },
      sunShadowMatrix: { value: new THREE.Matrix4() },
      sunShadowBias: { value: 0 },
      sunShadowIntensity: { value: 1 },
    },
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D opaqueDepth;
      uniform mat4 projectionInverse, cameraWorld;
      uniform vec3 boundsMin, boundsMax;
      uniform float density;
      uniform vec3 sunDirection, sunRadiance, ambientRadiance, fogColor;
      #if VOLUMETRIC_SHADOW == 2
        uniform highp sampler2DShadow sunShadow;
      #elif VOLUMETRIC_SHADOW == 1
        uniform sampler2D sunShadow;
      #endif
      #if VOLUMETRIC_SHADOW > 0
        uniform mat4 sunShadowMatrix;
        uniform float sunShadowBias, sunShadowIntensity;
      #endif

      vec3 unproject(float depth) {
        vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        return (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
      }

      // Parallel slabs are explicit: no 0 * infinity at box faces or infinite ray bounds.
      bool clipBox(vec3 origin, vec3 direction, inout float enter, inout float exit) {
        for (int axis = 0; axis < 3; axis++) {
          if (abs(direction[axis]) < 1e-8) {
            if (origin[axis] < boundsMin[axis] || origin[axis] > boundsMax[axis]) return false;
          } else {
            float a = (boundsMin[axis] - origin[axis]) / direction[axis];
            float b = (boundsMax[axis] - origin[axis]) / direction[axis];
            enter = max(enter, min(a, b));
            exit = min(exit, max(a, b));
            if (exit <= enter) return false;
          }
        }
        return exit > enter;
      }

      float visibility(vec3 position) {
        #if VOLUMETRIC_SHADOW > 0
          vec4 projected = sunShadowMatrix * vec4(position, 1.0);
          if (projected.w <= 0.0) return 1.0;
          vec3 coord = projected.xyz / projected.w;
          coord.z += sunShadowBias;
          if (any(lessThan(coord, vec3(0.0))) || any(greaterThan(coord, vec3(1.0)))) return 1.0;
          #if VOLUMETRIC_SHADOW == 2
            float lit = texture(sunShadow, coord);
          #else
            float lit = step(coord.z, texture2D(sunShadow, coord.xy).r);
          #endif
          return mix(1.0, lit, sunShadowIntensity);
        #else
          return 1.0;
        #endif
      }

      void main() {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        if (density <= 0.0) return;
        vec3 origin = unproject(0.0);
        vec3 ray = unproject(1.0) - origin;
        float rayLength = length(ray);
        if (!(rayLength > 0.0) || isinf(rayLength) || isnan(rayLength)) return;
        vec3 direction = ray / rayLength;
        float enter = 0.0, exit = rayLength;
        float depth = texture2D(opaqueDepth, vUv).r;
        if (depth < 1.0) exit = min(exit, max(0.0, dot(unproject(depth) - origin, direction)));
        if (!clipBox(origin, direction, enter, exit)) return;

        float stepLength = (exit - enter) / 48.0;
        float stepTransmittance = exp(-density * stepLength);
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float diagonal = length(boundsMax - boundsMin);
        vec3 scattering = vec3(0.0);
        float transmittance = 1.0;
        for (int i = 0; i < 48; i++) {
          vec3 position = origin + direction * (enter + (float(i) + jitter) * stepLength);
          float sunEnter = 0.0, sunExit = diagonal;
          bool sunHit = clipBox(position, sunDirection, sunEnter, sunExit);
          float sunTransmittance = exp(-density * (sunHit ? sunExit : 0.0));
          vec3 incoming = sunRadiance * (0.0795774715 * visibility(position) * sunTransmittance)
            + ambientRadiance * 0.08;
          scattering += transmittance * (1.0 - stepTransmittance) * incoming * fogColor;
          transmittance *= stepTransmittance;
        }
        gl_FragColor = vec4(scattering, transmittance);
      }
    `,
  })
  private readonly compositeMaterial = new THREE.ShaderMaterial({
    name: 'VolumetricComposite', vertexShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    uniforms: { beauty: { value: null }, volume: { value: this.target.texture } },
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D beauty, volume;
      void main() {
        vec4 color = texture2D(beauty, vUv);
        vec4 atmosphere = texture2D(volume, vUv);
        gl_FragColor = vec4(color.rgb * atmosphere.a + atmosphere.rgb, color.a);
      }
    `,
  })
  private readonly quad = new FullScreenQuad(this.scattering)
  private readonly lightTarget = new THREE.Vector3()
  private disposed = false

  setSize(width: number, height: number) {
    if (this.disposed) throw new Error('VolumetricLighting is disposed.')
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('VolumetricLighting requires positive pixel dimensions.')
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height)
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, opaqueDepth: THREE.DepthTexture, config: VolumetricLightingConfig) {
    if (this.disposed) throw new Error('VolumetricLighting is disposed.')
    const { bounds, density, color, light, ambient } = config
    const empty = bounds.isEmpty()
    if (!Number.isFinite(density) || density < 0 || !empty && ![...bounds.min, ...bounds.max].every(Number.isFinite)) {
      throw new Error('VolumetricLighting requires finite bounds and nonnegative finite density.')
    }
    const u = this.scattering.uniforms
    u.opaqueDepth.value = opaqueDepth
    u.projectionInverse.value.copy(camera.projectionMatrixInverse)
    u.cameraWorld.value.copy(camera.matrixWorld)
    u.boundsMin.value.copy(empty ? this.lightTarget.setScalar(0) : bounds.min)
    u.boundsMax.value.copy(empty ? this.lightTarget : bounds.max)
    u.density.value = empty ? 0 : density
    u.fogColor.value.set(color ?? 0xffffff)
    light.getWorldPosition(u.sunDirection.value)
    light.target.getWorldPosition(this.lightTarget)
    u.sunDirection.value.sub(this.lightTarget).normalize()
    if (u.sunDirection.value.lengthSq() === 0) u.sunDirection.value.set(0, 1, 0)
    u.sunRadiance.value.copy(light.color).multiplyScalar(light.visible ? light.intensity : 0)
    u.ambientRadiance.value.copy(ambient)
    // r185 PCF is a comparison depth texture, never the shadow map's color attachment.
    // Compile the sampler out entirely when unavailable; no incompatible fallback texture.
    const depth = renderer.shadowMap.enabled && light.castShadow ? light.shadow.map?.depthTexture : null
    const shadowMode = depth?.compareFunction === THREE.LessEqualCompare ? 2 : depth && depth.compareFunction === null ? 1 : 0
    if (this.scattering.defines.VOLUMETRIC_SHADOW !== shadowMode) {
      this.scattering.defines.VOLUMETRIC_SHADOW = shadowMode
      this.scattering.needsUpdate = true
    }
    u.sunShadow.value = shadowMode ? depth : null
    u.sunShadowMatrix.value.copy(light.shadow.matrix)
    u.sunShadowBias.value = light.shadow.bias
    u.sunShadowIntensity.value = light.shadow.intensity
    this.quad.material = this.scattering
    renderer.setRenderTarget(this.target)
    this.quad.render(renderer)
  }

  composite(renderer: THREE.WebGLRenderer, beauty: THREE.Texture, target: THREE.WebGLRenderTarget) {
    if (this.disposed) throw new Error('VolumetricLighting is disposed.')
    this.compositeMaterial.uniforms.beauty.value = beauty
    this.quad.material = this.compositeMaterial
    renderer.setRenderTarget(target)
    this.quad.render(renderer)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.target.dispose()
    this.scattering.dispose()
    this.compositeMaterial.dispose()
    this.quad.dispose()
  }
}
