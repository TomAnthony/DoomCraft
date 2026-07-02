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
npm run server  # game relay server
npm test
```

`npm run gen` requires the Chocolate Doom source at
`reference/chocolate-doom` (`git clone --depth 1
https://github.com/chocolate-doom/chocolate-doom.git reference/chocolate-doom`).

## License

GPL-2.0-only. Contains code ported from Chocolate Doom / the original Doom
source release. Game data (`DOOM2.WAD`) is not included.
