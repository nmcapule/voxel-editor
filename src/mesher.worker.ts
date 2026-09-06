import { meshChunk, type MeshData } from './mesher'

interface MeshJob {
  id: number
  version: number
  voxels: ArrayBuffer
}

type WorkerRequest =
  | { type: 'palette'; palette: ArrayBuffer; transparent: ArrayBuffer }
  | { type: 'mesh'; jobs: MeshJob[]; faceGrid: boolean }

interface MeshResult extends MeshData {
  id: number
  version: number
}

let palette = new Uint32Array(256)
let transparent = new Uint8Array(256)
const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === 'palette') {
    palette = new Uint32Array(event.data.palette)
    transparent = new Uint8Array(event.data.transparent)
    return
  }

  const { jobs, faceGrid } = event.data
  const results: MeshResult[] = jobs.map(job => ({
    id: job.id,
    version: job.version,
    ...meshChunk(new Uint8Array(job.voxels), palette, faceGrid, transparent),
  }))
  const transfers: Transferable[] = []
  for (const result of results) transfers.push(result.positions.buffer, result.normals.buffer, result.colors.buffer, result.uvs.buffer, result.indices.buffer, result.faceLines.buffer)
  scope.postMessage({ type: 'meshed', results }, transfers)
}
scope.postMessage({ type: 'ready' })

export {}
