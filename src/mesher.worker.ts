import { meshChunk, meshFaceGrid } from './mesher'

interface MeshJob {
  id: number
  version: number
  voxels: ArrayBuffer
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
    const faceLines = meshFaceGrid(new Uint8Array(job.voxels), transparent)
    scope.postMessage({ type: 'gridded', results: [{ id: job.id, version: job.version, faceLines }] }, [faceLines.buffer])
    return
  }
  const result = {
    id: job.id,
    version: job.version,
    ...meshChunk(new Uint8Array(job.voxels), undefined, event.data.faceGrid, transparent),
  }
  scope.postMessage({ type: 'meshed', results: [result] }, [result.positions.buffer, result.normals.buffer, result.uvs.buffer, result.indices.buffer, result.faceLines.buffer])
}
scope.postMessage({ type: 'ready' })

export {}
