import * as THREE from 'three';
import type Stats from 'stats.js';

import { createGridHelper, createPlane, createSkybox, createSpotLight } from './helpers/create';
import OrbitControls from './controls/orbit_controls';
import KeyboardListener from './controls/keyboard_listener';

export default class Game {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: OrbitControls;
  clock: THREE.Clock;
  raycaster: THREE.Raycaster;

  keyboard: KeyboardListener;
  attachables: Array<THREE.Mesh>;
  rolloverMesh: THREE.Mesh;

  keys = new Set<string>();

  constructor(readonly canvas: HTMLCanvasElement, readonly stats?: Stats) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, this.width / this.height, 1, 10000);
    // this.camera = new THREE.OrthographicCamera(-1000, 1000, 500, -500, 1, 10000);
    this.keyboard = new KeyboardListener(window.document.body);
    this.clock = new THREE.Clock();
    this.controls = new OrbitControls(this.camera, this.keyboard);
    this.raycaster = new THREE.Raycaster(this.camera.position);

    this.attachables = [];

    this.scene.background = new THREE.Color(0xf0f0f0);
    this.camera.position.set(500, 800, 1300);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.resize();
    this.initObjects();

    this.canvas.addEventListener('pointerdown', this.onPointerDown.bind(this));
    this.canvas.addEventListener('pointermove', this.onPointerMove.bind(this));

    this.keyboard
      .on('q', () => {
        const camera = new THREE.PerspectiveCamera(75, this.width / this.height, 1, 10000);
        camera.quaternion.copy(this.camera.quaternion);
        camera.position.copy(this.camera.position);

        this.camera = camera;
        this.controls = new OrbitControls(this.camera, this.keyboard);
        this.raycaster = new THREE.Raycaster(this.camera.position);
        this.render();
      })
      .on('e', () => {
        const camera = new THREE.OrthographicCamera(-1000, 1000, 500, -500, 1, 10000);
        camera.quaternion.copy(this.camera.quaternion);
        camera.position.copy(this.camera.position);

        this.camera = camera;
        this.controls = new OrbitControls(this.camera, this.keyboard);
        this.raycaster = new THREE.Raycaster(this.camera.position);
        this.render();
      });
  }

  dispose() {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown.bind(this));
    this.canvas.removeEventListener('pointermove', this.onPointerMove.bind(this));

    this.renderer.dispose();
    this.controls.dispose();
    this.keyboard.dispose();
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
    this.scene.add(createSpotLight(), createGridHelper(1000, 20), ...this.attachables);

    const geometry = new THREE.BoxGeometry(50, 50, 50);
    const material = new THREE.MeshBasicMaterial({
      color: 'blue',
      opacity: 0.5,
      transparent: true,
    });
    this.rolloverMesh = new THREE.Mesh(geometry, material);

    this.scene.add(this.rolloverMesh);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.95);
    this.scene.add(ambientLight);
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
    // This is a hack. Apparently, raycaster.setFromCamera mutates the camera position so
    // we have to save the position and then restore it later to compensate.
    const save = this.camera.position.clone();
    this.raycaster.setFromCamera(this.pointer(event), this.camera);
    this.camera.position.set(save.x, save.y, save.z);

    const intersects = this.raycaster.intersectObjects(this.attachables);
    if (intersects.length > 0) {
      const intersect = intersects[0];

      this.rolloverMesh.position.copy(intersect.point).add(intersect.face.normal);
      this.rolloverMesh.position.divideScalar(50).floor().multiplyScalar(50).addScalar(25);
    }

    this.render();
  }

  private onPointerDown(event: PointerEvent) {
    const colors = [0xff9aa2, 0xffb7b2, 0xffdac1, 0xe2f0cb, 0xb5ead7, 0xc7ceea];

    const voxel = this.rolloverMesh.clone();
    voxel.material = new THREE.MeshStandardMaterial({
      color: colors[Math.floor(Math.random() * colors.length)],
    });
    voxel.castShadow = true;
    voxel.receiveShadow = true;
    this.scene.add(voxel);
    this.attachables.push(voxel);

    this.onPointerMove(event);
  }

  start() {
    this.stats?.begin();

    const elapsed = this.clock.getDelta();
    this.tick(elapsed);
    this.render(elapsed);
    this.controls.update(elapsed);
    this.keyboard.update(elapsed);

    this.stats?.end();

    window.requestAnimationFrame(this.start.bind(this));
  }

  render(elapsed?: number) {
    this.renderer.render(this.scene, this.camera);
  }

  tick(elapsed: number) {
    // this.scene.children.forEach(object => {
    //   object.rotation.x += delta;
    //   object.rotation.y += delta;
    // });
    // this.projector.setFromCamera();
  }
}
