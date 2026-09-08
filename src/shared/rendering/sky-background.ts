import * as THREE from 'three'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'

export const SKY_BACKGROUND_FOV = 80

const panoramaDirection = `
  vec3 panoramaDirection(vec2 uv, float aspect, mat4 cameraWorld) {
    vec2 plane = (uv * 2.0 - 1.0) * vec2(aspect, 1.0) * ${Math.tan(THREE.MathUtils.degToRad(SKY_BACKGROUND_FOV / 2))};
    return normalize(mat3(cameraWorld) * vec3(plane, -1.0));
  }
`

/** Linear HDR backdrop only. RasterPipeline owns this material and borrows the scene texture. */
export class SkyBackground extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: 'SkyBackground', depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
      uniforms: {
        skyMap: { value: null }, cameraWorld: { value: new THREE.Matrix4() },
        skyRotation: { value: new THREE.Matrix4() }, aspect: { value: 1 }, intensity: { value: 1 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        #include <common>
        varying vec2 vUv;
        uniform sampler2D skyMap;
        uniform mat4 cameraWorld, skyRotation;
        uniform float aspect, intensity;
        ${panoramaDirection}
        void main() {
          vec3 direction = mat3(skyRotation) * panoramaDirection(vUv, aspect, cameraWorld);
          gl_FragColor = vec4(texture2D(skyMap, equirectUv(direction)).rgb * intensity, 1.0);
        }
      `,
    })
  }

  update(camera: THREE.Camera, scene: THREE.Scene) {
    this.uniforms.skyMap.value = scene.background
    this.uniforms.cameraWorld.value.copy(camera.matrixWorld)
    this.uniforms.skyRotation.value.makeRotationFromEuler(scene.backgroundRotation).invert()
    this.uniforms.aspect.value = camera.projectionMatrixInverse.elements[0] / camera.projectionMatrixInverse.elements[5]
    this.uniforms.intensity.value = scene.backgroundIntensity
  }
}

/** Pinned 0.0.24 integration. Its low-resolution tracer shares this physical material.
 * Only primary/transmissive misses use the virtual direction; camera rays, BVH and MIS stay native.
 */
export function installSkyBackground(tracer: WebGLPathTracer, enabled: boolean): THREE.IUniform<boolean> {
  const material = (tracer as unknown as { _pathTracer?: { material?: THREE.ShaderMaterial } })._pathTracer?.material
  if (!material?.isShaderMaterial || !material.uniforms.cameraWorldMatrix || !material.uniforms.invProjectionMatrix) {
    throw new Error('Sky background: unsupported path tracer physical material.')
  }
  const replacements = [
    ['Ray getCameraRay() {', `
      uniform bool panoramaEnabled;
      vec2 panoramaUv;
      ${panoramaDirection}
      vec3 panoramaMissDirection(vec3 direction, vec3 primaryDirection) {
        #if CAMERA_TYPE == 1 && FEATURE_BACKGROUND_MAP
          if (panoramaEnabled) {
            float aspect = invProjectionMatrix[0][0] / invProjectionMatrix[1][1];
            vec3 backdrop = panoramaDirection(panoramaUv, aspect, cameraWorldMatrix);
            // Rotate the miss by the primary-to-virtual ray angle, retaining refraction deflection.
            vec3 axis = cross(primaryDirection, backdrop);
            return direction + cross(axis, direction)
              + cross(axis, cross(axis, direction)) / (1.0 + dot(primaryDirection, backdrop));
          }
        #endif
        return direction;
      }
      Ray getCameraRay() {`],
    ['Ray ray;', 'panoramaUv = jitteredUv;\n\t\tRay ray;'],
    ['Ray ray = getCameraRay();', 'Ray ray = getCameraRay();\n\t\tvec3 panoramaPrimaryDirection = ray.direction;'],
    ['sampleBackground( ray.direction, rand2( 2 ) )', 'sampleBackground( panoramaMissDirection(ray.direction, panoramaPrimaryDirection), rand2( 2 ) )'],
  ] as const
  let shader = material.fragmentShader
  if (shader.includes('panoramaEnabled')) throw new Error('Sky background: path tracer material is already patched.')
  for (const [marker, replacement] of replacements) {
    if (shader.split(marker).length !== 2) throw new Error(`Sky background: unsupported path tracer shader marker: ${marker}`)
    shader = shader.replace(marker, replacement)
  }
  const uniform = { value: enabled }
  material.uniforms.panoramaEnabled = uniform
  material.fragmentShader = shader
  material.needsUpdate = true
  return uniform
}
