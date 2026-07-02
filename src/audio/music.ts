// Music: DMX MUS lumps (D_RUNNIN etc.) parsed and played through a small
// WebAudio synthesizer. Not an OPL emulation — GM patches map to a few
// oscillator presets, percussion to noise/pitch-drop voices — but the
// tracks are recognizably themselves. MUS format:
// https://doomwiki.org/wiki/MUS

import type { WadFile } from '../wad/wad.ts';
import type { AudioPlayer } from './audio.ts';

const MUS_TICRATE = 140;

interface MusEvent {
  time: number; // seconds from song start
  type: number; // 0 release, 1 play, 4 controller
  channel: number;
  a: number;
  b: number;
}

interface ParsedSong {
  events: MusEvent[];
  duration: number;
}

function parseMus(data: Uint8Array): ParsedSong | null {
  if (data.length < 16 || data[0] !== 0x4d || data[1] !== 0x55 || data[2] !== 0x53) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const scoreLen = view.getUint16(4, true);
  const scoreStart = view.getUint16(6, true);

  const events: MusEvent[] = [];
  let pos = scoreStart;
  const end = Math.min(data.length, scoreStart + scoreLen);
  let time = 0;

  while (pos < end) {
    const desc = data[pos++]!;
    const type = (desc >> 4) & 7;
    const channel = desc & 15;
    let a = 0;
    let b = 0;

    switch (type) {
      case 0: // release note
        a = data[pos++]! & 0x7f;
        break;
      case 1: { // play note
        const nb = data[pos++]!;
        a = nb & 0x7f;
        b = nb & 0x80 ? data[pos++]! & 0x7f : -1; // -1 = keep last volume
        break;
      }
      case 2: // pitch wheel
        a = data[pos++]!;
        break;
      case 3: // system event
        a = data[pos++]!;
        break;
      case 4: // controller
        a = data[pos++]!;
        b = data[pos++]!;
        break;
      case 6: // score end
        pos = end;
        break;
      default: // 5/7: no or one byte payload
        break;
    }
    if (type !== 6) events.push({ time, type, channel, a, b });

    if (desc & 0x80) {
      // variable-length delay in 140Hz ticks
      let ticks = 0;
      for (;;) {
        const byte = data[pos++]!;
        ticks = (ticks << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) break;
      }
      time += ticks / MUS_TICRATE;
    }
  }
  return { events, duration: time };
}

interface Preset {
  type: OscillatorType;
  attack: number;
  release: number;
  gain: number;
  detune?: number;
}

function presetFor(patch: number): Preset {
  if (patch < 8) return { type: 'triangle', attack: 0.005, release: 0.3, gain: 0.9 }; // piano
  if (patch < 16) return { type: 'triangle', attack: 0.002, release: 0.5, gain: 0.7 }; // chromatic
  if (patch < 24) return { type: 'sawtooth', attack: 0.03, release: 0.1, gain: 0.45 }; // organ
  if (patch < 26) return { type: 'triangle', attack: 0.005, release: 0.25, gain: 0.8 }; // ac guitar
  if (patch < 32) return { type: 'square', attack: 0.004, release: 0.15, gain: 0.5, detune: 5 }; // e guitar
  if (patch < 40) return { type: 'triangle', attack: 0.004, release: 0.12, gain: 1.0 }; // bass
  if (patch < 56) return { type: 'sawtooth', attack: 0.06, release: 0.25, gain: 0.4 }; // strings
  if (patch < 72) return { type: 'square', attack: 0.02, release: 0.12, gain: 0.45 }; // brass/reed
  if (patch < 80) return { type: 'triangle', attack: 0.03, release: 0.15, gain: 0.5 }; // pipe
  if (patch < 96) return { type: 'sawtooth', attack: 0.01, release: 0.2, gain: 0.5 }; // synth
  return { type: 'triangle', attack: 0.01, release: 0.2, gain: 0.5 };
}

function midiFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

interface Voice {
  osc: OscillatorNode[];
  gain: GainNode;
  release: number;
  channel: number;
  /** velocity * preset level, before channel volume */
  velLevel: number;
}

export class MusicPlayer {
  private song: ParsedSong | null = null;
  private lumpName: string | null = null;
  private startTime = 0;
  private nextEvent = 0;
  private timer: number | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  // per-channel state
  private patches = new Array<number>(16).fill(0);
  private volumes = new Array<number>(16).fill(100);
  private lastVol = new Array<number>(16).fill(100);
  private pans = new Array<number>(16).fill(64);
  private bends = new Array<number>(16).fill(128);
  private voices = new Map<string, Voice>();

  constructor(
    private readonly wad: WadFile,
    private readonly audio: AudioPlayer,
  ) {
    audio.onReady = () => {
      if (this.lumpName) this.startPlayback();
    };
  }

  /** Select and (once audio is unlocked) loop a music lump, e.g. D_RUNNIN. */
  play(lumpName: string): void {
    if (this.lumpName === lumpName && this.timer !== null) return;
    this.stop();
    this.lumpName = lumpName;
    if (this.audio.ctx) this.startPlayback();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const v of this.voices.values()) this.killVoice(v, 0.01);
    this.voices.clear();
    this.song = null;
  }

  private startPlayback(): void {
    const ctx = this.audio.ctx;
    if (!ctx || !this.lumpName || !this.wad.has(this.lumpName)) return;
    this.song = parseMus(this.wad.read(this.lumpName));
    if (!this.song || this.song.events.length === 0) return;

    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const ch = this.noiseBuffer.getChannelData(0);
      // deterministic-ish noise is irrelevant here (presentation only)
      let seed = 0x1234;
      for (let i = 0; i < ch.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        ch[i] = (seed / 0x40000000 - 1) * 0.8;
      }
    }

    this.patches.fill(0);
    this.volumes.fill(100);
    this.lastVol.fill(100);
    this.bends.fill(128);
    this.startTime = ctx.currentTime + 0.1;
    this.nextEvent = 0;
    this.timer = window.setInterval(() => this.pump(), 90);
  }

  private key(channel: number, note: number): string {
    return `${channel}:${note}`;
  }

  private killVoice(v: Voice, release: number): void {
    const ctx = this.audio.ctx!;
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + release);
    for (const o of v.osc) o.stop(t + release + 0.02);
  }

  private pump(): void {
    const ctx = this.audio.ctx;
    if (!ctx || !this.song) return;
    const horizon = ctx.currentTime + 0.3;

    while (this.nextEvent < this.song.events.length) {
      const ev = this.song.events[this.nextEvent]!;
      const when = this.startTime + ev.time;
      if (when > horizon) return;
      this.nextEvent++;
      this.dispatch(ev, Math.max(when, ctx.currentTime));
    }

    // loop
    if (this.nextEvent >= this.song.events.length) {
      this.startTime = this.startTime + this.song.duration + 0.5;
      this.nextEvent = 0;
    }
  }

  private dispatch(ev: MusEvent, when: number): void {
    switch (ev.type) {
      case 0: { // release
        const k = this.key(ev.channel, ev.a);
        const v = this.voices.get(k);
        if (v) {
          this.killVoice(v, v.release);
          this.voices.delete(k);
        }
        break;
      }
      case 1: { // play note
        if (ev.b >= 0) this.lastVol[ev.channel] = ev.b;
        const vol = this.lastVol[ev.channel]!;
        if (ev.channel === 15) this.percussion(ev.a, vol, when);
        else this.noteOn(ev.channel, ev.a, vol, when);
        break;
      }
      case 3: // system event: 10/11 = all (sounds|notes) off
        if (ev.a === 10 || ev.a === 11) {
          for (const [k, v] of this.voices) {
            if (k.startsWith(`${ev.channel}:`)) {
              this.killVoice(v, 0.05);
              this.voices.delete(k);
            }
          }
        }
        break;
      case 4: // controller
        if (ev.a === 0) this.patches[ev.channel] = ev.b;
        else if (ev.a === 3) {
          this.volumes[ev.channel] = ev.b;
          // apply volume fades to already-sounding notes too
          for (const v of this.voices.values()) {
            if (v.channel === ev.channel) {
              v.gain.gain.setTargetAtTime(v.velLevel * (ev.b / 127), when, 0.02);
            }
          }
        } else if (ev.a === 4) this.pans[ev.channel] = ev.b;
        break;
      case 2: // pitch wheel (±2 semitones over 0..255, 128 = center)
        this.bends[ev.channel] = ev.a;
        break;
    }
  }

  private noteOn(channel: number, note: number, vol: number, when: number): void {
    const ctx = this.audio.ctx!;
    const k = this.key(channel, note);
    const existing = this.voices.get(k);
    if (existing) {
      this.killVoice(existing, 0.01);
      this.voices.delete(k);
    }

    const preset = presetFor(this.patches[channel]!);
    const bend = Math.pow(2, ((this.bends[channel]! - 128) / 128) * (2 / 12));
    const freq = midiFreq(note) * bend;
    const oscCount = preset.detune ? 2 : 1;
    // divide by oscillator count so detuned presets aren't twice as loud
    const velLevel = ((vol / 127) * preset.gain * 0.12) / oscCount;
    const level = velLevel * (this.volumes[channel]! / 127);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + preset.attack);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (this.pans[channel]! - 64) / 64;
    gain.connect(pan).connect(this.audio.musicGain!);

    const oscs: OscillatorNode[] = [];
    const mk = (detune: number) => {
      const osc = ctx.createOscillator();
      osc.type = preset.type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(gain);
      osc.start(when);
      oscs.push(osc);
    };
    mk(0);
    if (preset.detune) mk(preset.detune);

    this.voices.set(k, { osc: oscs, gain, release: preset.release, channel, velLevel });
  }

  private percussion(note: number, vol: number, when: number): void {
    const ctx = this.audio.ctx!;
    const level = (vol / 127) * (this.volumes[15]! / 127) * 0.25;
    const out = this.audio.musicGain!;

    const noise = (dur: number, filterType: BiquadFilterType, freq: number, lvl: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer!;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0005, lvl), when);
      g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
      src.connect(f).connect(g).connect(out);
      src.start(when);
      src.stop(when + dur + 0.02);
    };
    const thump = (from: number, to: number, dur: number, lvl: number) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(from, when);
      osc.frequency.exponentialRampToValueAtTime(to, when + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0005, lvl), when);
      g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
      osc.connect(g).connect(out);
      osc.start(when);
      osc.stop(when + dur + 0.02);
    };

    if (note === 35 || note === 36) thump(160, 50, 0.12, level * 1.6); // kick
    else if (note === 38 || note === 40) {
      thump(220, 120, 0.05, level * 0.7);
      noise(0.12, 'bandpass', 1600, level);
    } else if (note === 42 || note === 44) noise(0.04, 'highpass', 7000, level * 0.8);
    else if (note === 46) noise(0.22, 'highpass', 6000, level * 0.7); // open hat
    else if (note >= 41 && note <= 50) thump(100 + (note - 41) * 25, 60, 0.15, level); // toms
    else if (note === 49 || note === 55 || note === 57) noise(0.5, 'highpass', 4500, level); // crash
    else if (note === 51 || note === 59) noise(0.25, 'bandpass', 9000, level * 0.6); // ride
    else noise(0.08, 'bandpass', 3000, level * 0.6);
  }
}

/** D_xxx music lump for a Doom 2 map number. */
export function musicLumpForMap(map: number, musicNames: readonly (string | null)[], musRunnin: number): string {
  const name = musicNames[musRunnin + (map - 1)];
  return name ? `D_${name.toUpperCase()}` : 'D_RUNNIN';
}
