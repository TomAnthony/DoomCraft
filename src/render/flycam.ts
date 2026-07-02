// Pointer-lock fly camera for debug fly-throughs (M2). Replaced by the
// sim-driven player camera from M3 onward.

import * as THREE from 'three';
import { requestLock } from '../input/input.ts';

export class FlyCamera {
  yaw = 0;
  pitch = 0;
  speed = 500; // units/sec
  private readonly keys = new Set<string>();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    element: HTMLElement,
  ) {
    element.addEventListener('click', () => requestLock(element));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== element) return;
      this.yaw -= e.movementX * 0.002;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.002));
    });
    document.addEventListener('keydown', (e) => this.keys.add(e.code));
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  update(dt: number): void {
    const speed = this.speed * (this.keys.has('ShiftLeft') ? 3 : 1) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const pos = this.camera.position;
    if (this.keys.has('KeyW')) pos.addScaledVector(forward, speed);
    if (this.keys.has('KeyS')) pos.addScaledVector(forward, -speed);
    if (this.keys.has('KeyA')) pos.addScaledVector(right, -speed);
    if (this.keys.has('KeyD')) pos.addScaledVector(right, speed);
    if (this.keys.has('KeyQ') || this.keys.has('Space')) pos.y += speed;
    if (this.keys.has('KeyE') || this.keys.has('KeyC')) pos.y -= speed;
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
