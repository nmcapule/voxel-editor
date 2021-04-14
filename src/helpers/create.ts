import * as THREE from 'three';

export function createSkybox() {
  const geometry = new THREE.BoxGeometry(10000, 10000, 10000);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffee, side: THREE.BackSide });
  const skybox = new THREE.Mesh(geometry, material);

  return skybox;
}

export function createInstancedCubes(count = 1000) {
  const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const limit = Math.sqrt(Math.sqrt(count));

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < count; i++) {
    mesh.setColorAt(i, new THREE.Color(Math.random(), Math.random(), Math.random()));
    mesh.setMatrixAt(
      i,
      new THREE.Matrix4()
        .identity()
        .makeTranslation(
          Math.floor(i % limit),
          Math.floor(i / limit) % limit,
          Math.floor(i / (limit * limit)),
        ),
    );
  }

  return mesh;
}

export function createPlane(w = 1000, h = 1000) {
  const geometry = new THREE.PlaneGeometry(w, h);
  geometry.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());

  return mesh;
}

export function createGridHelper(size = 10, divisions = 10) {
  return new THREE.GridHelper(size, divisions);
}
