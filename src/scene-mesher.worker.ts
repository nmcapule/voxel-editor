import { meshSceneChunk, type SceneMeshJob } from './scene-mesher'

const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = (event: MessageEvent<SceneMeshJob>) => {
  const { key, generation } = event.data
  try {
    const mesh = meshSceneChunk(event.data)
    scope.postMessage({ key, generation, mesh }, [mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer, mesh.faceLines.buffer])
  } catch (error) {
    scope.postMessage({ key, generation, error: error instanceof Error ? error.message : 'Scene meshing failed' })
  }
}
