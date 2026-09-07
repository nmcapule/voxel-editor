import * as THREE from 'three'
import { BVHShaderGLSL, MeshBVH, MeshBVHUniformStruct, UIntVertexAttributeTexture } from 'three-mesh-bvh'
import { CHUNK_SIZE, VoxelDocument, chunkCoords } from '../src/editor'
import { meshChunk } from '../src/mesher'
// @ts-expect-error The dependency ships this GLSL module without declarations.
import { util_functions } from 'three-gpu-pathtracer/src/shader/common/util_functions.glsl.js'

const water = 12, glass = 31, solid = 3
type RayCheck = {
  name: string
  origin: THREE.Vector3
  direction: THREE.Vector3
  expected: number[]
  alternative?: number[]
}

// Synchronous draws/readbacks inside an async API avoid yielding borrowed renderer state to RAF.
// This checks straight transmission and FrontSide skips, not BSDF sampling or refraction.
export async function runGpuRayChecks(webgl: THREE.WebGLRenderer) {
  const gl = webgl.getContext()
  if (gl.isContextLost()) throw new Error('GPU ray checks require a live WebGL2 context')
  const saved = {
    target: webgl.getRenderTarget(), face: webgl.getActiveCubeFace(), mip: webgl.getActiveMipmapLevel(),
    autoClear: webgl.autoClear, clearColor: webgl.getClearColor(new THREE.Color()), clearAlpha: webgl.getClearAlpha(),
    toneMapping: webgl.toneMapping, outputColorSpace: webgl.outputColorSpace,
    xr: webgl.xr.enabled, shadows: webgl.shadowMap.enabled,
  }
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  })
  const bvhUniform = new MeshBVHUniformStruct()
  const materialIds = new UIntVertexAttributeTexture()
  const rayData = new THREE.DataTexture(new Float32Array(8), 1, 2, THREE.RGBAFormat, THREE.FloatType)
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    uniforms: { bvh: { value: bvhUniform }, materialIds: { value: materialIds }, rayData: { value: rayData } },
    vertexShader: /* glsl */`
      precision highp float;
      in vec3 position;
      void main() { gl_Position = vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp int;
      precision highp sampler2D;
      precision highp usampler2D;
      precision highp isampler2D;
      #define PI 3.141592653589793
      ${BVHShaderGLSL.common_functions}
      ${BVHShaderGLSL.bvh_struct_definitions}
      ${BVHShaderGLSL.bvh_ray_functions}
      ${util_functions}
      uniform BVH bvh;
      uniform usampler2D materialIds;
      uniform sampler2D rayData;
      out vec4 result;

      void main() {
        int rayIndex = int(gl_FragCoord.x);
        vec3 origin = texelFetch(rayData, ivec2(rayIndex, 0), 0).xyz;
        vec3 direction = normalize(texelFetch(rayData, ivec2(rayIndex, 1), 0).xyz);
        vec3 sequence = vec3(0.0);
        int count = 0;
        // RGB contains up to three material IDs. Alpha: 255 complete, 254 budget, 253 overflow.
        float status = 254.0;
        for (int traversal = 0; traversal < 14; traversal++) {
          uvec4 faceIndices = uvec4(0u);
          vec3 faceNormal = vec3(0.0), barycoord = vec3(0.0);
          float side = 0.0, dist = 0.0;
          bool hit = bvhIntersectFirstHit(bvh, origin, direction, faceIndices, faceNormal, barycoord, side, dist);
          if (!hit) { status = 255.0; break; }
          if (side == 1.0) {
            if (count == 3) { status = 253.0; break; }
            uint id = uTexelFetch1D(materialIds, faceIndices.x).r;
            sequence[count] = float(id);
            count++;
            if (id != ${water}u && id != ${glass}u) { status = 255.0; break; }
          }
          // BVH faceNormal is already flipped against the ray, including back faces.
          // Both a FrontSide rejection and straight transmission step to its opposite side.
          origin = stepRayOrigin(origin, direction, -faceNormal, dist);
        }
        result = vec4(sequence, status) / 255.0;
      }
    `,
  })
  const screenGeometry = new THREE.BufferGeometry()
  screenGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  const screen = new THREE.Mesh(screenGeometry, material)
  screen.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(screen)
  const camera = new THREE.Camera()
  const checks: { name: string; reverseTriangles: boolean; rgba: number[]; expected: number[]; alternative?: number[] }[] = []

  const run = (name: string, document: VoxelDocument, rays: RayCheck[], ground = false, centered = true) => {
    const center = centered ? new THREE.Vector3(document.dimensions.x / 2, 0, document.dimensions.z / 2) : new THREE.Vector3()
    const positions: number[] = [], indices: number[] = [], ids: number[] = []
    const transparent = new Uint8Array(256)
    transparent[water] = transparent[glass] = 1
    for (const id of document.chunks.keys()) {
      const chunk = chunkCoords(id)
      const mesh = meshChunk(document.paddedChunk(id, true), document.palette, false, transparent)
      const vertexOffset = positions.length / 3
      const chunkIds = new Uint32Array(mesh.positions.length / 3)
      for (const group of mesh.groups) chunkIds.fill(group.materialIndex, group.vertexStart, group.vertexStart + group.vertexCount)
      for (let i = 0; i < mesh.positions.length; i += 3) {
        if (!mesh.positions.subarray(i, i + 3).every(Number.isInteger)) throw new Error(`${name}: mesher must emit integer planes, not insets`)
        positions.push(mesh.positions[i] + chunk.x * CHUNK_SIZE - center.x,
          mesh.positions[i + 1] + chunk.y * CHUNK_SIZE,
          mesh.positions[i + 2] + chunk.z * CHUNK_SIZE - center.z)
        ids.push(chunkIds[i / 3])
      }
      for (const index of mesh.indices) indices.push(index + vertexOffset)
    }
    if (ground) {
      const base = positions.length / 3
      const x0 = -1 - center.x, x1 = document.dimensions.x + 1 - center.x
      const z0 = -1 - center.z, z1 = document.dimensions.z + 1 - center.z
      // Upward-facing ground, deliberately the only noninteger geometry in these fixtures.
      positions.push(x0, -0.03, z0, x0, -0.03, z1, x1, -0.03, z1, x1, -0.03, z0)
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      ids.push(solid, solid, solid, solid)
    }
    const geometry = new THREE.BufferGeometry()
    try {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      materialIds.updateFrom(new THREE.Uint32BufferAttribute(ids, 1))
      const data = new Float32Array(rays.length * 8)
      for (const [i, ray] of rays.entries()) {
        ray.origin.clone().sub(center).toArray(data, i * 4)
        ray.direction.clone().normalize().toArray(data, (rays.length + i) * 4)
      }
      rayData.dispose()
      rayData.image = { data, width: rays.length, height: 2 }
      rayData.needsUpdate = true
      target.setSize(rays.length, 1)
      const pixels = new Uint8Array(rays.length * 4)
      const reversed: number[] = []
      for (let i = indices.length - 3; i >= 0; i -= 3) reversed.push(indices[i], indices[i + 1], indices[i + 2])
      for (const reverseTriangles of [false, true]) {
        geometry.setIndex(reverseTriangles ? reversed : indices)
        bvhUniform.updateFrom(new MeshBVH(geometry, { indirect: true, targetLeafSize: 1 }))
        // Target viewport/scissor are pixel-sized and independent of the canvas pixel ratio.
        // Do not change the renderer's canvas viewport/scissor settings.
        webgl.setRenderTarget(target)
        webgl.setClearColor(0, 0)
        webgl.clear(true, false, false)
        webgl.render(scene, camera)
        webgl.readRenderTargetPixels(target, 0, 0, rays.length, 1, pixels)
        if (gl.isContextLost()) throw new Error(`${name}: context lost during GPU traversal`)
        for (const [i, ray] of rays.entries()) {
          const rgba = [...pixels.subarray(i * 4, i * 4 + 4)]
          const matches = (expected: number[]) => rgba.slice(0, 3).every((value, channel) => value === (expected[channel] ?? 0))
          const entry = { name: `${name}: ${ray.name}`, reverseTriangles, rgba, expected: ray.expected, alternative: ray.alternative }
          if (rgba[3] !== 255 || !(matches(ray.expected) || ray.alternative && matches(ray.alternative))) {
            throw new Error(`GPU ray check failed: ${JSON.stringify(entry)} (alpha 0=no draw, 253=overflow, 254=traversal limit)`)
          }
          checks.push(entry)
        }
      }
    } finally {
      geometry.dispose()
    }
  }

  try {
    webgl.autoClear = false
    webgl.toneMapping = THREE.NoToneMapping
    webgl.outputColorSpace = THREE.LinearSRGBColorSpace
    webgl.xr.enabled = false
    webgl.shadowMap.enabled = false
    for (const axis of [0, 1, 2]) for (const [location, boundary, height] of [
      ['within chunk', 8, 6], ['chunk seam', 16, 6], ['near y255', 254, 255], ['high seam', axis === 1 ? 240 : 16, 255],
    ] as const) for (const sign of [1, -1]) {
      const document = new VoxelDocument({ x: 256, y: 256, z: 256 })
      const cell = new THREE.Vector3(6, height, 6)
      for (const [coordinate, id] of [[boundary - 1, glass], [boundary, water], [sign > 0 ? boundary + 1 : boundary - 2, solid]]) {
        cell.setComponent(axis, coordinate)
        document.setVoxel(cell.x, cell.y, cell.z, id)
      }
      const origin = cell.clone().add(new THREE.Vector3(0.37, 0.43, 0.61))
      origin.setComponent(axis, sign > 0 ? boundary - 1.5 : boundary + 1.5)
      const direction = new THREE.Vector3().setComponent(axis, sign)
      const expected = sign > 0 ? [glass, water, solid] : [water, glass, solid]
      const inside = origin.clone().setComponent(axis, boundary - sign * 0.25)
      run(`${'XYZ'[axis]} ${location} direction ${sign}`, document, [
        { name: 'full transmission', origin, direction, expected },
        { name: 'first hit is the exact opposing interface', origin: inside, direction, expected: expected.slice(1) },
      ])
    }

    for (const y of [0, 255]) {
      const document = new VoxelDocument({ x: 256, y: 256, z: 256 })
      document.setVoxel(0, y, 0, water)
      document.setVoxel(1, y, 0, glass)
      run(`oblique single water y${y}`, document, [{ name: 'no repeated water',
        origin: new THREE.Vector3(1.185, y + 2, 0.43), direction: new THREE.Vector3(-0.2, -1, 0), expected: [water] }])
    }

    for (const sign of [1, -1]) for (const [height, width] of [[4, 4], [5, 3], [3, 5]]) {
      const document = new VoxelDocument()
      for (let y = 5; y < 5 + height; y++) for (let z = 5; z < 5 + width; z++) document.setVoxel(6, y, z, glass)
      for (let y = 6; y < 8; y++) for (let z = 6; z < 8; z++) {
        document.setVoxel(7, y, z, water)
        document.setVoxel(sign > 0 ? 8 : 5, y, z, solid)
      }
      run(`oblique merged ${height}x${width} direction ${sign}`, document, [{ name: 'each medium once',
        origin: new THREE.Vector3(sign > 0 ? 5.5 : 8.5, 6.43, 6.61), direction: new THREE.Vector3(sign, 0.07, 0.11),
        expected: sign > 0 ? [glass, water, solid] : [water, glass, solid] }])
    }

    const top = new VoxelDocument({ x: 256, y: 256, z: 256 })
    const topRays: RayCheck[] = []
    for (const [x, z, id] of [[15, 15, glass], [16, 15, water], [15, 16, water]]) {
      top.setVoxel(x, 255, z, id)
      for (const dx of [0.01, 0.5, 0.99]) for (const dz of [0.01, 0.5, 0.99]) topRays.push({
        name: `L surface ${x + dx},${z + dz}`, origin: new THREE.Vector3(x + dx, 257, z + dz),
        direction: new THREE.Vector3(0, -1, 0), expected: [id],
      })
    }
    for (const [x, z] of [[16, 15.5], [15.5, 16], [16, 16]]) topRays.push({
      name: `exact top-down seam ${x},${z}`, origin: new THREE.Vector3(x, 257, z),
      direction: new THREE.Vector3(0, -1, 0), expected: [glass], alternative: [water],
    })
    topRays.push({ name: 'L missing corner remains empty', origin: new THREE.Vector3(16.5, 257, 16.5),
      direction: new THREE.Vector3(0, -1, 0), expected: [] })
    run('top-down interface coverage at y256', top, topRays)

    const floor = new VoxelDocument({ x: 256, y: 256, z: 256 })
    const floorRays: RayCheck[] = []
    for (const x of [0, 255]) for (const z of [0, 255]) {
      floor.setVoxel(x, 0, z, water)
      for (const offset of [0.01, 0.5, 0.99]) for (const y of [2, 0.43]) floorRays.push({
        name: `water ${x + offset},${z + offset} from y${y}`, origin: new THREE.Vector3(x + offset, y, z + offset),
        direction: new THREE.Vector3(0, -1, 0), expected: y > 1 ? [water, solid] : [solid],
      })
    }
    run('water above ground -0.03 at centered workspace edges', floor, floorRays, true)
    run('water above ground -0.03 at uncentered coordinates up to 255.99', floor, floorRays, true, false)
    return { passed: checks.length, materialIds: { water, glass, solid }, checks }
  } finally {
    webgl.setRenderTarget(saved.target, saved.face, saved.mip)
    webgl.setClearColor(saved.clearColor, saved.clearAlpha)
    webgl.autoClear = saved.autoClear
    webgl.toneMapping = saved.toneMapping
    webgl.outputColorSpace = saved.outputColorSpace
    webgl.xr.enabled = saved.xr
    webgl.shadowMap.enabled = saved.shadows
    target.dispose()
    bvhUniform.dispose()
    materialIds.dispose()
    rayData.dispose()
    material.dispose()
    screenGeometry.dispose()
  }
}
