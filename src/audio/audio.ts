// Sound effects: DMX lumps (DS<name>) decoded to AudioBuffers, played
// with vanilla-ish distance attenuation and stereo separation.
// Consumes sim.soundEvents each tic — sound is presentation, not state.

import type { SoundEvent } from '../sim/sim.ts';
import { FRACUNIT } from '../sim/fixed.ts';
import type { WadFile } from '../wad/wad.ts';

// Vanilla S_CLIPPING_DIST / S_CLOSE_DIST (map units).
const CLIPPING_DIST = 1200;
const CLOSE_DIST = 160;

export interface Listener {
  x: number; // map units (not fixed)
  y: number;
  angle: number; // radians
}

export class AudioPlayer {
  ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer | null>();
  private sfxGain: GainNode | null = null;
  musicGain: GainNode | null = null;
  private sfxVolume = 0.6;
  private musicVolume = 0.5;
  /** called once the context exists (music player hooks in here) */
  onReady: (() => void) | null = null;

  constructor(private readonly wad: WadFile) {}

  /** Must be called from a user gesture to unlock audio. */
  resume(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxVolume;
      this.sfxGain.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.ctx.destination);
      this.onReady?.();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = v;
    if (this.sfxGain) this.sfxGain.gain.value = v;
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    if (this.musicGain) this.musicGain.gain.value = v;
  }

  getSfxVolume(): number {
    return this.sfxVolume;
  }

  getMusicVolume(): number {
    return this.musicVolume;
  }

  private buffer(name: string): AudioBuffer | null {
    const cached = this.buffers.get(name);
    if (cached !== undefined) return cached;
    let decoded: AudioBuffer | null = null;
    const lumpName = `DS${name.toUpperCase()}`;
    if (this.ctx && this.wad.has(lumpName)) {
      const data = this.wad.read(lumpName);
      if (data.length > 8 && data[0] === 3) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const rate = view.getUint16(2, true);
        const count = view.getUint32(4, true);
        // 16 bytes of lead-in/lead-out padding are included in count.
        const start = 8 + 16;
        const n = Math.max(0, Math.min(count - 32, data.length - start));
        if (n > 0) {
          decoded = this.ctx.createBuffer(1, n, rate);
          const ch = decoded.getChannelData(0);
          for (let i = 0; i < n; i++) ch[i] = (data[start + i]! - 128) / 128;
        }
      }
    }
    this.buffers.set(name, decoded);
    return decoded;
  }

  playEvents(events: readonly SoundEvent[], listener: Listener): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    for (const ev of events) {
      const buffer = this.buffer(ev.name);
      if (!buffer) continue;

      const sx = ev.x / FRACUNIT;
      const sy = ev.y / FRACUNIT;
      const isGlobal = ev.x === 0 && ev.y === 0 && !ev.mobj;
      const dx = sx - listener.x;
      const dy = sy - listener.y;
      const dist = isGlobal ? 0 : Math.hypot(dx, dy);
      if (dist > CLIPPING_DIST) continue;

      let volume = 1;
      if (dist > CLOSE_DIST) {
        volume = (CLIPPING_DIST - dist) / (CLIPPING_DIST - CLOSE_DIST);
      }

      // stereo separation from the angle to the source
      let pan = 0;
      if (!isGlobal && dist > CLOSE_DIST) {
        const angleTo = Math.atan2(dy, dx) - listener.angle;
        pan = -Math.sin(angleTo) * 0.75;
      }

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(gain).connect(panner).connect(this.sfxGain!);
      src.start();
    }
  }
}
