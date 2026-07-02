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

## Playing multiplayer

1. Run the relay somewhere both players can reach: `npm run server`
   (port 8666; for internet play, put it on a VPS or forward the port).
2. Player 1 opens `http://<client-host>/?server=ws://<relay-host>:8666&map=1`
   and reads the 4-letter room code off the screen.
3. Player 2 opens `http://<client-host>/?server=ws://<relay-host>:8666&room=CODE`.
4. The game starts the moment player 2 joins. Co-op rules with friendly
   fire: monsters spawn once, cleared levels stay clear, dead players
   press USE (E) to respawn.
