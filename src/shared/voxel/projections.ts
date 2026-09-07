import type { VoxelDocument } from './document'

export const faceViews = ['front', 'back', 'left', 'right', 'top', 'bottom'] as const
export type FaceView = typeof faceViews[number]

export function projectFaces(document: VoxelDocument, views: readonly FaceView[] = faceViews) {
  const { x: X, y: Y, z: Z } = document.dimensions
  const mappings = {
    front: { width: X, height: Y, direction: '+Z (max z)', pixelAxes: 'u=x, v=Y-1-y' },
    back: { width: X, height: Y, direction: '-Z (min z)', pixelAxes: 'u=X-1-x, v=Y-1-y' },
    left: { width: Z, height: Y, direction: '-X (min x)', pixelAxes: 'u=z, v=Y-1-y' },
    right: { width: Z, height: Y, direction: '+X (max x)', pixelAxes: 'u=Z-1-z, v=Y-1-y' },
    top: { width: X, height: Z, direction: '+Y (max y)', pixelAxes: 'u=x, v=z' },
    bottom: { width: X, height: Z, direction: '-Y (min y)', pixelAxes: 'u=x, v=Z-1-z' },
  }
  const faces = views.map(name => {
    const mapping = mappings[name]
    return { name, ...mapping, rgba: new Uint8ClampedArray(mapping.width * mapping.height * 4) }
  })
  if (!faces.length) return faces
  const depths = faces.map(face => new Float32Array(face.width * face.height).fill(Infinity))

  document.forEachVisibleVoxel((x, y, z, color) => {
    const rgb = document.palette[color]
    for (let i = 0; i < faces.length; i++) {
      const face = faces[i]
      let u: number, v: number, depth: number
      // Depth is distance from the named side; smaller values win regardless of traversal order.
      switch (face.name) {
        case 'front': u = x; v = Y - 1 - y; depth = Z - 1 - z; break
        case 'back': u = X - 1 - x; v = Y - 1 - y; depth = z; break
        case 'left': u = z; v = Y - 1 - y; depth = x; break
        case 'right': u = Z - 1 - z; v = Y - 1 - y; depth = X - 1 - x; break
        case 'top': u = x; v = z; depth = Y - 1 - y; break
        case 'bottom': u = x; v = Z - 1 - z; depth = y; break
      }
      const pixel = u + v * face.width
      if (depth >= depths[i][pixel]) continue
      depths[i][pixel] = depth
      const offset = pixel * 4
      face.rgba[offset] = (rgb >> 16) & 255
      face.rgba[offset + 1] = (rgb >> 8) & 255
      face.rgba[offset + 2] = rgb & 255
      face.rgba[offset + 3] = 255
    }
  })
  return faces
}
