import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import type Stats from 'stats.js';

import { createGridHelper, createPlane, createSkybox } from './helpers/create';

export default class Game {
  renderer: THREE.Renderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: OrbitControls;
  clock: THREE.Clock;
  raycaster: THREE.Raycaster;

  attachables: Array<THREE.Mesh>;
  rolloverMesh: THREE.Mesh;

  constructor(readonly canvas: HTMLCanvasElement, readonly stats?: Stats) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, this.width / this.height, 1, 10000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster(this.camera.position);

    this.attachables = [];

    this.camera.position.set(500, 800, 1300);
    this.controls.enableKeys = true;

    this.resize();
    this.initObjects();

    this.canvas.addEventListener('pointerdown', this.onPointerDown.bind(this));
    this.canvas.addEventListener('pointermove', this.onPointerMove.bind(this));
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown.bind(this));
    this.canvas.removeEventListener('pointermove', this.onPointerMove.bind(this));
  }

  pointer(event: PointerEvent) {
    const x = (event.offsetX / this.width) * 2 - 1;
    const y = -(event.offsetY / this.height) * 2 + 1;
    return new THREE.Vector2(x, y);
  }

  get width() {
    return this.canvas.clientWidth;
  }

  get height() {
    return this.canvas.clientHeight;
  }

  private initObjects() {
    this.attachables = [createPlane()];
    this.scene.add(createSkybox(), createGridHelper(1000, 20), ...this.attachables);

    const geometry = new THREE.BoxGeometry(50, 50, 50);
    const material = new THREE.MeshBasicMaterial({
      color: 'blue',
      opacity: 0.5,
      transparent: true,
    });
    this.rolloverMesh = new THREE.Mesh(geometry, material);

    this.scene.add(this.rolloverMesh);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(20, 10, 0);
    directionalLight.castShadow = true;
    this.scene.add(directionalLight);
  }

  private resize() {
    const pixelRatio = window.devicePixelRatio;
    const width = (this.width * pixelRatio) | 0;
    const height = (this.height * pixelRatio) | 0;
    const needResize = this.canvas.width !== width || this.canvas.height !== height;
    if (needResize) {
      this.renderer.setSize(width, height, false);
    }
    return needResize;
  }

  private onPointerMove(event: PointerEvent) {
    this.raycaster.setFromCamera(this.pointer(event), this.camera);
    const intersects = this.raycaster.intersectObjects(this.attachables);
    if (intersects.length > 0) {
      const intersect = intersects[0];

      this.rolloverMesh.position.copy(intersect.point).add(intersect.face.normal);
      this.rolloverMesh.position.divideScalar(50).floor().multiplyScalar(50).addScalar(25);
    }

    this.render();
  }

  private onPointerDown(event: PointerEvent) {
    this.raycaster.setFromCamera(this.pointer(event), this.camera);
    const intersects = this.raycaster.intersectObjects(this.attachables);

    const voxel = this.rolloverMesh.clone();
    voxel.material = new THREE.MeshPhysicalMaterial({
      color: 0x0000ff,
    });
    voxel.castShadow = true;
    voxel.receiveShadow = true;
    this.scene.add(voxel);
    this.attachables.push(voxel);

    this.onPointerMove(event);

    console.log(`Clicked objects:`, intersects);
  }

  start() {
    this.stats?.begin();

    this.tick();
    this.render();
    this.controls.update();

    this.stats?.end();

    window.requestAnimationFrame(this.start.bind(this));
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  tick() {
    const delta = this.clock.getDelta();
    // this.scene.children.forEach(object => {
    //   object.rotation.x += delta;
    //   object.rotation.y += delta;
    // });
    // this.projector.setFromCamera();
  }
}
