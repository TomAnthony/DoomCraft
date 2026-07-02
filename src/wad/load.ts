// WAD acquisition: fetch /DOOM2.WAD from the host if it serves one,
// otherwise ask the player for their own copy (cached in IndexedDB so
// it's a one-time step per browser). Lets a deployment keep the WAD
// entirely off the server — nothing to download that you didn't bring.

const DB_NAME = 'doomcraft';
const STORE = 'files';
const KEY = 'DOOM2.WAD';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<ArrayBuffer | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result instanceof ArrayBuffer ? req.result : null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut(buf: ArrayBuffer): Promise<void> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(buf, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function looksLikeDoom2(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'IWAD' && magic !== 'PWAD') return false;
  // cheap MAP01 scan of the directory (full parse happens later anyway)
  const view = new DataView(buf);
  const count = view.getInt32(4, true);
  const dirofs = view.getInt32(8, true);
  if (dirofs < 0 || dirofs + count * 16 > buf.byteLength) return false;
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

function pickWad(root: HTMLElement): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'font-family:monospace;background:radial-gradient(ellipse at center,#2a0f0f 0%,#000 75%);z-index:20';
    panel.innerHTML = `
      <div style="text-align:center;max-width:440px">
        <div style="color:#e33;font:bold 28px monospace;margin-bottom:12px">DOOM2.WAD NEEDED</div>
        <div style="color:#a66;font:14px monospace;line-height:1.5;margin-bottom:22px">
          This server doesn't distribute the game data.<br>
          Select your own DOOM2.WAD — it stays in this browser<br>
          (cached locally, never uploaded anywhere).
        </div>
        <div id="wad-drop" style="border:2px dashed #822;padding:34px 20px;color:#ddd;
          font:bold 15px monospace;cursor:pointer;background:#1a1a1a">
          DROP DOOM2.WAD HERE<br>
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
        err.textContent = 'That does not look like DOOM2.WAD (no MAP01 found).';
        return;
      }
      await idbPut(buf);
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

/** Server copy first, then browser cache, then ask the player. */
export async function loadWadBuffer(root: HTMLElement): Promise<ArrayBuffer> {
  try {
    const resp = await fetch('/DOOM2.WAD');
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      if (looksLikeDoom2(buf)) return buf;
    }
  } catch {
    // no server copy — fall through
  }
  const cached = await idbGet().catch(() => null);
  if (cached && looksLikeDoom2(cached)) return cached;
  return pickWad(root);
}
