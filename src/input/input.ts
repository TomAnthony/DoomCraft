// Keyboard/mouse → ticcmd (G_BuildTiccmd equivalent, modern bindings).
// Mouse deltas accumulate continuously and are consumed at each 35Hz tic;
// the un-consumed remainder is exposed for latency-free camera look.

import {
  BT2_BLOCKPLACE, BT2_BLOCKREMOVE, BT2_JUMP,
  BT_ATTACK, BT_CHANGE, BT_USE, BT_WEAPONSHIFT,
} from '../sim/defs.ts';
import type { TicCmd } from '../sim/ticcmd.ts';

// Vanilla run speeds.
const FORWARDMOVE = 0x32;
const SIDEMOVE = 0x28;

// Mouse sensitivity: pixels → angleturn units (i16, added as <<16 BAM).
const YAW_SCALE = 12;
const PITCH_SCALE = 12;

export class InputHandler {
  private keys = new Set<string>();
  private mouseDx = 0;
  private mouseDy = 0;
  private attackHeld = false;
  private altHeld = false;
  private weaponPressed = -1;

  attach(element: HTMLElement): void {
    element.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== element) {
        element.requestPointerLock();
        return;
      }
      if (e.button === 0) this.attackHeld = true;
      if (e.button === 2) this.altHeld = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.attackHeld = false;
      if (e.button === 2) this.altHeld = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== element) return;
      this.mouseDx += e.movementX;
      this.mouseDy += e.movementY;
    });
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 8) this.weaponPressed = n - 1;
      }
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  /** Un-consumed mouse yaw, in angleturn units (for camera prediction). */
  pendingYawTurn(): number {
    return (-this.mouseDx * YAW_SCALE) | 0;
  }

  pendingPitchTurn(): number {
    return (-this.mouseDy * PITCH_SCALE) | 0;
  }

  buildTicCmd(): TicCmd {
    const cmd: TicCmd = {
      forwardmove: 0, sidemove: 0, angleturn: 0, pitch: 0, buttons: 0, buttons2: 0,
    };
    if (this.keys.has('KeyW')) cmd.forwardmove += FORWARDMOVE;
    if (this.keys.has('KeyS')) cmd.forwardmove -= FORWARDMOVE;
    if (this.keys.has('KeyD')) cmd.sidemove += SIDEMOVE;
    if (this.keys.has('KeyA')) cmd.sidemove -= SIDEMOVE;

    const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, v | 0));
    cmd.angleturn = clamp16(-this.mouseDx * YAW_SCALE);
    cmd.pitch = clamp16(-this.mouseDy * PITCH_SCALE);
    this.mouseDx = 0;
    this.mouseDy = 0;

    if (this.attackHeld || this.keys.has('ControlLeft')) cmd.buttons |= BT_ATTACK;
    if (this.keys.has('KeyE') || this.keys.has('KeyF')) cmd.buttons |= BT_USE;
    if (this.weaponPressed >= 0) {
      cmd.buttons |= BT_CHANGE | (this.weaponPressed << BT_WEAPONSHIFT);
      this.weaponPressed = -1;
    }
    if (this.keys.has('Space')) cmd.buttons2 |= BT2_JUMP;
    if (this.altHeld) cmd.buttons2 |= BT2_BLOCKREMOVE;
    void BT2_BLOCKPLACE; // used from M6 when the block gun is selected
    return cmd;
  }
}
