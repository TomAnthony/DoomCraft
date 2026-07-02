// In-game options overlay. Esc naturally exits pointer lock in browsers,
// so the menu appears whenever the lock is lost and Resume re-locks.

import type { AudioPlayer } from '../audio/audio.ts';
import type { InputHandler } from '../input/input.ts';

const STORAGE_KEY = 'doomcraft.options';

interface Saved {
  music: number;
  sfx: number;
  sensitivity: number;
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { music: 0.5, sfx: 0.6, sensitivity: 1, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { music: 0.5, sfx: 0.6, sensitivity: 1 };
}

export class OptionsMenu {
  private readonly panel: HTMLDivElement;
  visible = false;

  constructor(root: HTMLElement, audio: AudioPlayer, input: InputHandler, onResume: () => void) {
    const saved = load();
    audio.setMusicVolume(saved.music);
    audio.setSfxVolume(saved.sfx);
    input.sensitivity = saved.sensitivity;

    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
      'background:#000a;z-index:10;font-family:monospace';
    this.panel.innerHTML = `
      <div style="background:#1a1a1a;border:2px solid #822;padding:28px 36px;min-width:320px;color:#ddd">
        <div style="color:#e33;font:bold 26px monospace;text-align:center;margin-bottom:20px">OPTIONS</div>
        <label style="display:block;margin-bottom:16px">
          <span style="display:block;margin-bottom:4px;color:#e88">MUSIC VOLUME</span>
          <input id="opt-music" type="range" min="0" max="100" style="width:100%">
        </label>
        <label style="display:block;margin-bottom:16px">
          <span style="display:block;margin-bottom:4px;color:#e88">SOUND VOLUME</span>
          <input id="opt-sfx" type="range" min="0" max="100" style="width:100%">
        </label>
        <label style="display:block;margin-bottom:24px">
          <span style="display:block;margin-bottom:4px;color:#e88">MOUSE SENSITIVITY</span>
          <input id="opt-sens" type="range" min="10" max="300" style="width:100%">
        </label>
        <button id="opt-resume" style="width:100%;padding:10px;background:#822;color:#fff;
          border:none;font:bold 18px monospace;cursor:pointer">RESUME (or click the game)</button>
      </div>`;
    root.appendChild(this.panel);

    const music = this.panel.querySelector('#opt-music') as HTMLInputElement;
    const sfx = this.panel.querySelector('#opt-sfx') as HTMLInputElement;
    const sens = this.panel.querySelector('#opt-sens') as HTMLInputElement;
    music.value = String(Math.round(saved.music * 100));
    sfx.value = String(Math.round(saved.sfx * 100));
    sens.value = String(Math.round(saved.sensitivity * 100));

    const persist = () => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            music: Number(music.value) / 100,
            sfx: Number(sfx.value) / 100,
            sensitivity: Number(sens.value) / 100,
          }),
        );
      } catch {
        // ignore
      }
    };
    music.addEventListener('input', () => {
      audio.setMusicVolume(Number(music.value) / 100);
      persist();
    });
    sfx.addEventListener('input', () => {
      audio.setSfxVolume(Number(sfx.value) / 100);
      persist();
    });
    sens.addEventListener('input', () => {
      input.sensitivity = Number(sens.value) / 100;
      persist();
    });
    (this.panel.querySelector('#opt-resume') as HTMLButtonElement).addEventListener(
      'click',
      () => onResume(),
    );
  }

  show(): void {
    this.visible = true;
    this.panel.style.display = 'flex';
  }

  hide(): void {
    this.visible = false;
    this.panel.style.display = 'none';
  }
}
