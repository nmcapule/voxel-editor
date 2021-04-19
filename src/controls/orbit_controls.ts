import * as THREE from 'three';
import KeyboardListener from './keyboard_listener';

/**
 * Based on https://github.com/mrdoob/three.js/blob/master/examples/jsm/controls/OrbitControls.js
 */
export default class OrbitControls {
  /** Focus of the camera. */
  target = new THREE.Vector3();

  targetOffset = new THREE.Vector3();

  /** Sphere movement axis. */
  spherical = new THREE.Spherical();
  /** Sphere movement axis delta. */
  sphericalDelta = new THREE.Spherical();

  keys = new Set<string>();

  disposeKeyboardHooks: Function;

  constructor(readonly camera: THREE.Camera, readonly keyboard: KeyboardListener) {
    this.disposeKeyboardHooks = this.keyboard
      .on('r', elapsed => this.rotate(-elapsed * 1000, 0, 0))
      .on('f', elapsed => this.rotate(elapsed * 1000, 0, 0))
      .on('shift+a', elapsed => this.rotate(0, 0, -elapsed * Math.PI))
      .on('shift+d', elapsed => this.rotate(0, 0, elapsed * Math.PI))
      .on('shift+w', elapsed => this.rotate(0, elapsed * Math.PI, 0))
      .on('shift+s', elapsed => this.rotate(0, -elapsed * Math.PI, 0))
      .on('a', elapsed => this.pan(new THREE.Vector3(-elapsed, 0, 0)))
      .on('d', elapsed => this.pan(new THREE.Vector3(elapsed, 0, 0)))
      .on('w', elapsed => this.pan(new THREE.Vector3(0, 0, -elapsed)))
      .on('s', elapsed => this.pan(new THREE.Vector3(0, 0, elapsed)));
  }

  dispose() {
    this.disposeKeyboardHooks();
  }

  update(elapsed: number) {
    const quat = new THREE.Quaternion().setFromUnitVectors(
      this.camera.up,
      new THREE.Vector3(0, 1, 0),
    );

    // Calculate initial offset.
    const offset = new THREE.Vector3()
      .copy(this.camera.position)
      .sub(this.target)
      .applyQuaternion(quat);

    this.spherical.setFromVector3(offset);
    this.spherical.radius += this.sphericalDelta.radius;
    this.spherical.theta += this.sphericalDelta.theta;
    this.spherical.phi += this.sphericalDelta.phi;
    this.spherical.makeSafe();

    this.sphericalDelta.set(0, 0, 0);

    const normal = this.target
      .clone()
      .sub(this.camera.position)
      .add(this.camera.up)
      .normalize()
      .setY(0);
    const forward = normal.clone().multiplyScalar(-this.targetOffset.z);
    const strafe = normal
      .clone()
      .setX(-normal.z)
      .setZ(normal.x)
      .multiplyScalar(this.targetOffset.x);
    this.targetOffset = forward.add(strafe).normalize().multiplyScalar(10);
    this.target.add(this.targetOffset);
    this.targetOffset.set(0, 0, 0);

    offset.setFromSpherical(this.spherical);
    offset.applyQuaternion(quat.invert());

    // Apply quaternion offset to
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  lookAt(position: THREE.Vector3) {
    this.target = position;
  }

  rotate(radius = 0, phi = 0, theta = 0) {
    // zoom
    this.sphericalDelta.radius += radius;
    // up-down
    this.sphericalDelta.phi += phi;
    // left-right
    this.sphericalDelta.theta += theta;
  }

  pan(vector: THREE.Vector3) {
    this.targetOffset.add(vector);
  }
}
