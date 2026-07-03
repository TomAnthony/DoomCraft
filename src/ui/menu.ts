// Start menu: shown at the bare URL. Solo play, host a game, or join
// with a room code — navigation happens via URL params so links stay
// shareable and the game code paths stay unchanged.
//
// The GAME DATA selector covers WADs the server offers (freedm.wad is
// always public; DOOM2.WAD appears only in dev where vite serves it),
// the browser's own library (uploads + host-transferred WADs), and an
// upload option. Joining ignores it — you play whatever the host plays.

import { cacheWad, getWadChoice, listCachedWads, looksLikeDoom2, setWadChoice } from '../wad/load.ts';

export function showStartMenu(root: HTMLElement): void {
  root.style.background = '#000';
  const menu = document.createElement('div');
  menu.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'font-family:monospace;background:radial-gradient(ellipse at center,#2a0f0f 0%,#000 75%)';
  menu.innerHTML = `
    <div style="text-align:center;min-width:340px">
      <img src="/logo.png" alt="DoomCraft" width="150" height="150"
        style="display:block;margin:0 auto 8px;filter:drop-shadow(0 0 16px rgba(255,60,0,0.3))">
      <div style="color:#a66;font:13px monospace;margin-bottom:30px">DOOM II &times; MINECRAFT &mdash; 2-4 PLAYER DEATHMATCH WITH MONSTERS</div>

      <div style="margin-bottom:10px">
        <label style="color:#e88;font:bold 13px monospace;margin-right:8px">NAME</label>
        <input id="menu-name" maxlength="12" placeholder="Player" style="background:#1a1a1a;
          color:#ddd;border:1px solid #822;font:bold 14px monospace;padding:4px 8px;width:160px">
      </div>
      <div style="margin-bottom:10px">
        <label style="color:#e88;font:bold 13px monospace;margin-right:8px">MAP</label>
        <select id="menu-map" style="background:#1a1a1a;color:#ddd;border:1px solid #822;
          font:bold 14px monospace;padding:4px 8px"></select>
      </div>
      <div style="margin-bottom:18px">
        <label style="color:#e88;font:bold 13px monospace;margin-right:8px">GAME DATA</label>
        <select id="menu-wad" style="background:#1a1a1a;color:#ddd;border:1px solid #822;
          font:bold 14px monospace;padding:4px 8px;max-width:240px"></select>
        <div id="menu-wad-err" style="color:#e33;font:12px monospace;margin-top:6px;min-height:14px"></div>
      </div>

      <button id="menu-solo" style="display:block;width:100%;margin-bottom:10px;padding:12px;
        background:#822;color:#fff;border:none;font:bold 18px monospace;cursor:pointer">SOLO GAME</button>
      <button id="menu-host" style="display:block;width:100%;margin-bottom:8px;padding:12px;
        background:#822;color:#fff;border:none;font:bold 18px monospace;cursor:pointer">HOST MULTIPLAYER</button>
      <label style="display:block;margin-bottom:6px;color:#a66;font:12px monospace;cursor:pointer">
        <input id="menu-blocks" type="checkbox" checked style="margin-right:6px;vertical-align:middle">
        ALLOW BLOCK GUN (SLOT 8) IN MULTIPLAYER
      </label>
      <label style="display:block;margin-bottom:18px;color:#a66;font:12px monospace;cursor:pointer">
        <input id="menu-latejoin" type="checkbox" checked style="margin-right:6px;vertical-align:middle">
        ALLOW JOINS AFTER GAME START
      </label>

      <div style="display:flex;gap:8px">
        <input id="menu-code" maxlength="4" placeholder="CODE" style="flex:1;background:#1a1a1a;
          color:#ddd;border:1px solid #822;font:bold 18px monospace;padding:10px;
          text-transform:uppercase;text-align:center;letter-spacing:4px">
        <button id="menu-join" style="flex:2;padding:12px;background:#282828;color:#fff;
          border:1px solid #822;font:bold 18px monospace;cursor:pointer">JOIN GAME</button>
      </div>
      <div style="margin-top:16px;color:#a66;font:11px monospace">
        Please consider <a href="https://buymeacoffee.com/doomcraft" target="_blank"
          rel="noopener" style="color:#e88">donating to server costs</a>.
      </div>
    </div>`;
  root.appendChild(menu);

  const nameInput = menu.querySelector('#menu-name') as HTMLInputElement;
  try {
    nameInput.value = localStorage.getItem('doomcraft.playerName') ?? '';
  } catch {
    // ignore
  }
  nameInput.addEventListener('input', () => {
    try {
      localStorage.setItem('doomcraft.playerName', nameInput.value.trim());
    } catch {
      // ignore
    }
  });

  const mapSel = menu.querySelector('#menu-map') as HTMLSelectElement;
  for (let i = 1; i <= 32; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `MAP${String(i).padStart(2, '0')}`;
    mapSel.appendChild(opt);
  }

  // --- GAME DATA selector ---------------------------------------------------
  const wadSel = menu.querySelector('#menu-wad') as HTMLSelectElement;
  const wadErr = menu.querySelector('#menu-wad-err') as HTMLDivElement;
  const upload = document.createElement('input');
  upload.type = 'file';
  upload.accept = '.wad,.WAD';
  upload.style.display = 'none';
  menu.appendChild(upload);

  const addOpt = (value: string, label: string) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    wadSel.appendChild(o);
    return o;
  };

  void (async () => {
    // server-offered WADs (HEAD probe; DOOM2 only exists in dev)
    const served = async (name: string) => {
      try {
        return (await fetch(`/${name}`, { method: 'HEAD' })).ok;
      } catch {
        return false;
      }
    };
    const hasFreedm = await served('freedm.wad');
    const hasFreedoom2 = await served('freedoom2.wad');
    if (await served('DOOM2.WAD')) addOpt('builtin:DOOM2.WAD', 'DOOM2.WAD');
    // the sensible default: freedoom2 for solo play, freedm for deathmatch
    if (hasFreedm && hasFreedoom2) addOpt('auto:freedoom', 'FREEDOOM (match play style)');
    if (hasFreedoom2) addOpt('builtin:freedoom2.wad', 'FREEDOOM 2 (solo)');
    if (hasFreedm) addOpt('builtin:freedm.wad', 'FREEDM (deathmatch)');
    for (const w of await listCachedWads()) {
      addOpt(`idb:${w.hash}`, `${w.name.toUpperCase()} (saved)`);
    }
    addOpt('upload', 'UPLOAD A WAD…');
    const saved = getWadChoice();
    if (saved && [...wadSel.options].some((o) => o.value === saved)) wadSel.value = saved;
    else setWadChoice(wadSel.value);
  })();

  wadSel.onchange = () => {
    wadErr.textContent = '';
    if (wadSel.value === 'upload') upload.click();
    else setWadChoice(wadSel.value);
  };
  upload.onchange = async () => {
    const file = upload.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    if (!looksLikeDoom2(buf)) {
      wadErr.textContent = 'Not a Doom 2-format WAD (no MAP01 found).';
      wadSel.selectedIndex = 0;
      setWadChoice(wadSel.value);
      return;
    }
    const hash = await cacheWad(buf, file.name);
    const opt = addOpt(`idb:${hash}`, `${file.name.toUpperCase()} (saved)`);
    wadSel.insertBefore(opt, wadSel.querySelector('option[value=upload]'));
    wadSel.value = opt.value;
    setWadChoice(opt.value);
  };

  const go = (params: string) => {
    // preserve a ?wad=<key> secret handle across navigation
    const key = new URLSearchParams(location.search).get('wad');
    location.search = params + (key ? `&wad=${encodeURIComponent(key)}` : '');
  };
  (menu.querySelector('#menu-solo') as HTMLButtonElement).onclick = () =>
    go(`?map=${mapSel.value}`);
  (menu.querySelector('#menu-host') as HTMLButtonElement).onclick = () => {
    const blocks = (menu.querySelector('#menu-blocks') as HTMLInputElement).checked;
    const late = (menu.querySelector('#menu-latejoin') as HTMLInputElement).checked;
    go(`?host&map=${mapSel.value}${blocks ? '' : '&blocks=0'}${late ? '' : '&latejoin=0'}`);
  };

  const code = menu.querySelector('#menu-code') as HTMLInputElement;
  const join = () => {
    const c = code.value.trim().toUpperCase();
    if (c.length === 4) go(`?room=${c}`);
    else code.focus();
  };
  (menu.querySelector('#menu-join') as HTMLButtonElement).onclick = join;
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
}
