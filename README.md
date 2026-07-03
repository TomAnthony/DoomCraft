# DoomCraft

A browser-based, 2-player Doom 2 with an 8th weapon that places and removes
Minecraft-style blocks — build bridges, forts, and walls inside the original
Doom 2 maps, then blow holes in them.

- Faithful TypeScript port of the Doom gameplay core (Chocolate Doom, GPL-2)
- Three.js true-3D renderer driven by your own `DOOM2.WAD`
- Deterministic lockstep multiplayer over a tiny Node WebSocket relay

See [SPEC.md](SPEC.md) for the full specification.

## Requirements

- Node.js 22+
- Your own `DOOM2.WAD` placed in the project root (never committed or
  transmitted; both players need an identical copy)

## Development

```sh
npm install
npm run gen     # one-off: generate sim data tables from reference C source
npm run dev     # client dev server on http://localhost:5173
npm run server  # game relay server (ws + static, port 8666)
npm test
```

`npm run gen` requires the Chocolate Doom source at
`reference/chocolate-doom` (`git clone --depth 1
https://github.com/chocolate-doom/chocolate-doom.git reference/chocolate-doom`).

## Credits & provenance

- **id Software's Doom** (GPL-2) — the gameplay simulation is a
  statement-level TypeScript port of the original Doom source, via the
  **[Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom)**
  tree (GPL-2); the state/mobj/sound tables and math tables in
  `src/sim/data/` are code-generated directly from its C source.
- **[Freedoom / FreeDM](https://freedoom.github.io/)** (BSD-style) —
  `freedm.wad`, the freely-distributable default game data.
- **[Three.js](https://threejs.org/)** (MIT) — 3D rendering.
- **[earcut](https://github.com/mapbox/earcut)** (ISC) — sector polygon
  triangulation.
- **[ws](https://github.com/websockets/ws)** (MIT) — relay server
  WebSockets.
- Dev tooling: Vite (MIT), TypeScript (Apache-2.0), Vitest (MIT),
  ESLint (MIT), Playwright (Apache-2.0).
- Consulted (no code derived): wad-js (WAD format reference), the
  doom-webxr write-up (WAD→3D geometry approach). Doom.js-v2 was
  evaluated early and not used (unlicensed).

DOOM2.WAD is commercial id Software data: it is never committed,
bundled, or served except when explicitly registered by the operator.

## License

GPL-2.0-only. Contains code ported from Chocolate Doom / the original Doom
source release. Game data (`DOOM2.WAD`) is not included.

## Playing multiplayer (2-4 players)

One machine hosts everything on a single port:

```sh
npm start           # builds then serves game + WAD + relay on :8666
```

(`npm run server` alone serves the existing `dist/` without rebuilding —
the server warns on startup if that build is older than `src/`.)

1. `http://<host>:8666/` is a static introduction page; the PLAY button
   (or `/play` directly) opens the start menu — SOLO GAME, HOST
   MULTIPLAYER (with map/WAD pickers), and JOIN GAME.
2. The host clicks HOST MULTIPLAYER and sends the invite link (COPY
   button) or the 4-letter room code to 1-3 friends.
3. Friends paste the link, or type the code into JOIN GAME.
4. The host's lobby shows the roster; START GAME begins the match once
   2-4 players are in (and any WAD transfers have finished). Players
   leaving mid-game are dropped cleanly; the survivors keep playing.

The server also serves `freedoom2.wad` (Freedoom's single-player IWAD,
with monsters) from the project root if you place it there — it then
appears in the menu's GAME DATA selector.

Direct URLs: `/play?map=7` (solo), `/play?host&map=7`, `/play?room=CODE`.

### Game data (WADs)

- **FreeDM is the built-in default**: `freedm.wad` in the project root
  is freely distributable and always served at `/freedm.wad`. (FreeDM
  is deathmatch-only — its maps contain no monsters.)
- **The start menu has a GAME DATA selector**: server-offered WADs,
  your browser's saved WADs, and UPLOAD A WAD… (uploads are validated
  and cached in IndexedDB — local to your browser).
- **Host→joiner transfer**: whatever the host plays, the joiner gets.
  If the joiner's WAD hash doesn't match, the host's WAD streams to
  them directly over WebRTC (peer to peer — no server bandwidth), with
  an automatic relay fallback when a direct connection can't form.
  Verified by hash, cached for next time; joiners never pick anything.
- **Private server WADs**: commercial WADs are NOT served unless you
  register them: `npm run server -- --wad DOOM2.WAD:mysecret` serves
  the file only at `/wad/mysecret`, invisible to the menu. Load it with
  `?wad=mysecret` in the URL (the menu preserves the param when
  hosting). In dev, vite serves `/DOOM2.WAD` from the project root as
  the canonical default. For
internet play, run it on a VPS or port-forward 8666. Behind TLS/a
reverse proxy, the ws URL is derived automatically (wss on https).

Dev-mode alternative: run `npm run dev` (client on :5173) plus
`npm run server` (relay on :8666) and use
`/?server=ws://<host>:8666` / `&room=CODE` URLs on port 5173.

Mode: 2-4 player deathmatch with monsters — DM spawn points, all keys carried,
weapons respawn 30s after pickup, monsters spawn once and cleared
levels stay clear; dead players press E to respawn.
