import * as THREE from 'three';
import { PointOctree } from 'sparse-octree';

/** Represents a single voxel / cube in 4 bytes. */
export interface Voxel {
  color: number; // e.g. 0xffffff     (3 bytes)
  flags: number; // e.g. 0b00000001   (1 byte, unless we add more)
}

/**
 * Represents a collection of voxels.
 *
 * If we have a 256x256x256 model, it would cost around 68MB to store into memory.
 * Consider optimizing in the future.
 */
export class VoxelModel extends PointOctree<Voxel> {
  constructor(options?: { min?: THREE.Vector3; max?: THREE.Vector3 }) {
    super(
      options?.min || new THREE.Vector3(-10, -10, -10),
      options?.max || new THREE.Vector3(10, 10, 10),
    );
  }
}
