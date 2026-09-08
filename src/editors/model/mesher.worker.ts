import { meshChunk, meshFaceGrid } from '../../shared/voxel/mesher'

interface MeshJob {
  id: number
  version: number
  voxels?: ArrayBuffer
  layerId?: number
  active?: ArrayBuffer
  context?: ArrayBuffer
}

type WorkerRequest =
  | { type: 'palette'; palette?: ArrayBuffer; transparent: ArrayBuffer }
  | { type: 'mesh'; jobs: [MeshJob]; faceGrid: boolean }
  | { type: 'grid'; jobs: [MeshJob] }

let transparent = new Uint8Array(256)
const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === 'palette') {
    if (event.data.transparent.byteLength !== 256) throw new RangeError('Invalid transparency table size')
    transparent = new Uint8Array(event.data.transparent)
    return
  }

  // The parent schedules one chunk at a time so edits can supersede queued work.
  const { jobs } = event.data
  if (jobs.length !== 1) throw new RangeError('Expected exactly one mesher job')
  const job = jobs[0]
  if (event.data.type === 'grid') {
    const faceLines = job.voxels ? meshFaceGrid(new Uint8Array(job.voxels), transparent) : undefined
    const activeFaceLines = job.active ? meshFaceGrid(new Uint8Array(job.active), transparent) : undefined
    scope.postMessage({ type: 'gridded', results: [{ id: job.id, version: job.version, layerId: job.layerId, faceLines, activeFaceLines }] }, [...(faceLines ? [faceLines.buffer] : []), ...(activeFaceLines ? [activeFaceLines.buffer] : [])])
    return
  }
  const normal = job.voxels ? meshChunk(new Uint8Array(job.voxels), undefined, event.data.faceGrid, transparent) : undefined
  const active = job.active ? meshChunk(new Uint8Array(job.active), undefined, event.data.faceGrid, transparent) : undefined
  let context
  if (job.context && job.active) {
    const voxels = new Uint8Array(job.context), selected = new Uint8Array(job.active)
    // Never draw coincident context over the active layer, including chunk halos.
    for (let index = 0; index < voxels.length; index++) voxels[index] = selected[index] ? 0 : Number(voxels[index] !== 0)
    context = meshChunk(voxels)
  }
  const results = [{ id: job.id, version: job.version, normal, ...(active ? { layerId: job.layerId, active, context } : {}) }]
  const transfers = [...(normal ? [normal] : []), ...(active ? [active] : []), ...(context ? [context] : [])]
    .flatMap(mesh => [mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer, mesh.faceLines.buffer])
  scope.postMessage({ type: 'meshed', results }, transfers)
}
scope.postMessage({ type: 'ready' })

export {}
