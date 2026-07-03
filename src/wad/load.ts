// WAD acquisition and browser-side WAD library.
//
// Resolution order:
//   1. ?wad=<key>            — fetch /wad/<key> (server-registered via
//                              --wad path:key; the key can be a secret)
//   2. saved menu choice     — 'builtin:<name>' (fetch /<name>) or
//                              'idb:<hash>' (browser library)
//   3. /DOOM2.WAD            — dev-canonical convenience (vite serves it;
//                              the production server does not)
//   4. /freedm.wad           — freely-distributable default, served by
//                              both dev and production servers
//   5. interactive picker    — unless quiet (joiners skip it: the host
//                              transfers its WAD through the relay)
//
// The library lives in IndexedDB keyed by SHA-256 hash; uploads and
// host-transferred WADs land there so they're one-time per browser.

import { hashWad } from './wad.ts';

const DB_NAME = 'doomcraft';
const STORE = 'wads';
const CHOICE_KEY = 'doomcraft.wadChoice';

export interface CachedWadInfo {
  hash: string;
  name: string;
  size: number;
}

interface CachedWad extends CachedWadInfo {
  buf: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(hash: string): Promise<CachedWad | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(hash);
    req.onsuccess = () => resolve((req.result as CachedWad | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

/** Save a WAD into the browser library; returns its hash. */
export async function cacheWad(buf: ArrayBuffer, name: string): Promise<string> {
  const hash = await hashWad(buf);
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ hash, name, size: buf.byteLength, buf } satisfies CachedWad, hash);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  return hash;
}

/** List the browser WAD library (metadata only). */
export async function listCachedWads(): Promise<CachedWadInfo[]> {
  const db = await openDb();
  return new Promise((resolve) => {
    const out: CachedWadInfo[] = [];
    const req = db.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const { hash, name, size } = cur.value as CachedWad;
        out.push({ hash, name, size });
        cur.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => resolve(out);
  });
}

export function getWadChoice(): string | null {
  try {
    return localStorage.getItem(CHOICE_KEY);
  } catch {
    return null;
  }
}

export function setWadChoice(choice: string): void {
  try {
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // ignore
  }
}

/** Doom2-format sanity check: WAD magic + a MAP01 directory entry. */
export function looksLikeDoom2(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'IWAD' && magic !== 'PWAD') return false;
  const view = new DataView(buf);
  const count = view.getInt32(4, true);
  const dirofs = view.getInt32(8, true);
  if (dirofs < 0 || count < 0 || dirofs + count * 16 > buf.byteLength) return false;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < count; i++) {
    const o = dirofs + i * 16 + 8;
    if (
      bytes[o] === 77 && bytes[o + 1] === 65 && bytes[o + 2] === 80 && // MAP
      bytes[o + 3] === 48 && bytes[o + 4] === 49 && bytes[o + 5] === 0 // 01\0
    ) {
      return true;
    }
  }
  return false;
}

async function tryFetch(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    return looksLikeDoom2(buf) ? buf : null;
  } catch {
    return null;
  }
}

/** Interactive drop/browse picker; stores the pick in the library. */
export function pickWad(root: HTMLElement): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'font-family:monospace;background:radial-gradient(ellipse at center,#2a0f0f 0%,#000 75%);z-index:20';
    panel.innerHTML = `
      <div style="text-align:center;max-width:440px">
        <div style="color:#e33;font:bold 28px monospace;margin-bottom:12px">WAD NEEDED</div>
        <div style="color:#a66;font:14px monospace;line-height:1.5;margin-bottom:22px">
          Select a Doom 2-format WAD (e.g. DOOM2.WAD).<br>
          It stays in this browser — cached locally, never uploaded
          anywhere except to your game peer.
        </div>
        <div id="wad-drop" style="border:2px dashed #822;padding:34px 20px;color:#ddd;
          font:bold 15px monospace;cursor:pointer;background:#1a1a1a">
          DROP A WAD HERE<br>
          <span style="color:#a66;font-weight:normal;font-size:12px">or click to browse</span>
        </div>
        <div id="wad-err" style="color:#e33;font:13px monospace;margin-top:12px;min-height:16px"></div>
      </div>`;
    root.appendChild(panel);

    const drop = panel.querySelector('#wad-drop') as HTMLDivElement;
    const err = panel.querySelector('#wad-err') as HTMLDivElement;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.wad,.WAD';
    input.style.display = 'none';
    panel.appendChild(input);

    const accept = async (file: File | undefined) => {
      if (!file) return;
      const buf = await file.arrayBuffer();
      if (!looksLikeDoom2(buf)) {
        err.textContent = 'Not a Doom 2-format WAD (no MAP01 found).';
        return;
      }
      const hash = await cacheWad(buf, file.name);
      setWadChoice(`idb:${hash}`);
      panel.remove();
      resolve(buf);
    };

    drop.onclick = () => input.click();
    input.onchange = () => void accept(input.files?.[0]);
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.style.borderColor = '#e33';
    };
    drop.ondragleave = () => (drop.style.borderColor = '#822');
    drop.ondrop = (e) => {
      e.preventDefault();
      void accept(e.dataTransfer?.files?.[0]);
    };
  });
}

/**
 * Resolve the WAD to play. quiet mode (joiners) returns null instead of
 * showing the picker — the netgame lobby transfers the host's WAD.
 */
export async function loadWadBuffer(
  root: HTMLElement,
  opts: { quiet?: boolean } = {},
): Promise<ArrayBuffer | null> {
  // 1. explicit server key (possibly secret)
  const key = new URLSearchParams(location.search).get('wad');
  if (key) {
    const buf = await tryFetch(`/wad/${encodeURIComponent(key)}`);
    if (buf) return buf;
  }

  // 2. saved menu choice
  const choice = getWadChoice();
  if (choice?.startsWith('idb:')) {
    const hit = await idbGet(choice.slice(4)).catch(() => null);
    if (hit && looksLikeDoom2(hit.buf)) return hit.buf;
  } else if (choice?.startsWith('builtin:')) {
    const buf = await tryFetch(`/${encodeURIComponent(choice.slice(8))}`);
    if (buf) return buf;
  }

  // 3. dev-canonical DOOM2.WAD, 4. bundled freedm
  const dev = await tryFetch('/DOOM2.WAD');
  if (dev) return dev;
  const freedm = await tryFetch('/freedm.wad');
  if (freedm) return freedm;

  // 5. ask
  if (opts.quiet) return null;
  return pickWad(root);
}
