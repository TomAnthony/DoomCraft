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

## License

GPL-2.0-only. Contains code ported from Chocolate Doom / the original Doom
source release. Game data (`DOOM2.WAD`) is not included.

## Playing multiplayer (hosting for a friend)

One machine hosts everything on a single port:

```sh
npm start           # builds then serves game + WAD + relay on :8666
```

(`npm run server` alone serves the existing `dist/` without rebuilding —
the server warns on startup if that build is older than `src/`.)

1. Both players open `http://<host>:8666/` — a start menu offers
   SOLO GAME, HOST MULTIPLAYER (with a map picker), and JOIN GAME.
2. The host clicks HOST MULTIPLAYER and sends the invite link (COPY
   button) or the 4-letter room code.
3. The friend pastes the link, or types the code into JOIN GAME.
4. The game starts the moment player 2 joins.

Direct URLs still work: `/?map=7` (solo), `/?host&map=7`, `/?room=CODE`.

### Game data (WADs)

- **FreeDM is the built-in default**: `freedm.wad` in the project root
  is freely distributable and always served at `/freedm.wad`. (FreeDM
  is deathmatch-only — its maps contain no monsters.)
- **The start menu has a GAME DATA selector**: server-offered WADs,
  your browser's saved WADs, and UPLOAD A WAD… (uploads are validated
  and cached in IndexedDB — local to your browser).
- **Host→joiner transfer**: whatever the host plays, the joiner gets.
  If the joiner's WAD hash doesn't match, the host's WAD streams to
  them through the relay (progress shown), is verified by hash, and is
  cached for next time. Joiners never need to pick anything.
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

Mode: deathmatch with monsters — DM spawn points, all keys carried,
weapons respawn 30s after pickup, monsters spawn once and cleared
levels stay clear; dead players press E to respawn.
