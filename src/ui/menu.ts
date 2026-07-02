// Start menu: shown at the bare URL. Solo play, host a game, or join
// with a room code — navigation happens via URL params so links stay
// shareable and the game code paths stay unchanged.

export function showStartMenu(root: HTMLElement): void {
  root.style.background = '#000';
  const menu = document.createElement('div');
  menu.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'font-family:monospace;background:radial-gradient(ellipse at center,#2a0f0f 0%,#000 75%)';
  menu.innerHTML = `
    <div style="text-align:center;min-width:340px">
      <div style="color:#e33;font:bold 52px monospace;text-shadow:3px 3px 0 #500;margin-bottom:6px">DOOMCRAFT</div>
      <div style="color:#a66;font:13px monospace;margin-bottom:34px">DOOM II &times; MINECRAFT &mdash; 2-PLAYER DEATHMATCH WITH MONSTERS</div>

      <div style="margin-bottom:18px">
        <label style="color:#e88;font:bold 13px monospace;margin-right:8px">MAP</label>
        <select id="menu-map" style="background:#1a1a1a;color:#ddd;border:1px solid #822;
          font:bold 14px monospace;padding:4px 8px"></select>
      </div>

      <button id="menu-solo" style="display:block;width:100%;margin-bottom:10px;padding:12px;
        background:#822;color:#fff;border:none;font:bold 18px monospace;cursor:pointer">SOLO GAME</button>
      <button id="menu-host" style="display:block;width:100%;margin-bottom:18px;padding:12px;
        background:#822;color:#fff;border:none;font:bold 18px monospace;cursor:pointer">HOST MULTIPLAYER</button>

      <div style="display:flex;gap:8px">
        <input id="menu-code" maxlength="4" placeholder="CODE" style="flex:1;background:#1a1a1a;
          color:#ddd;border:1px solid #822;font:bold 18px monospace;padding:10px;
          text-transform:uppercase;text-align:center;letter-spacing:4px">
        <button id="menu-join" style="flex:2;padding:12px;background:#282828;color:#fff;
          border:1px solid #822;font:bold 18px monospace;cursor:pointer">JOIN GAME</button>
      </div>
    </div>`;
  root.appendChild(menu);

  const mapSel = menu.querySelector('#menu-map') as HTMLSelectElement;
  for (let i = 1; i <= 32; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `MAP${String(i).padStart(2, '0')}`;
    mapSel.appendChild(opt);
  }

  const go = (params: string) => {
    location.search = params;
  };
  (menu.querySelector('#menu-solo') as HTMLButtonElement).onclick = () =>
    go(`?map=${mapSel.value}`);
  (menu.querySelector('#menu-host') as HTMLButtonElement).onclick = () =>
    go(`?host&map=${mapSel.value}`);

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
