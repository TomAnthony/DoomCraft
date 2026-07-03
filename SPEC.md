# DoomCraft — Specification

A browser-based Doom 2 for exactly **2 players over the internet**, with an 8th
weapon that places and removes Minecraft-style blocks. This document is the
living specification: it is updated in the same commit as the behavior it
describes. Sections marked *(planned)* are specified but not yet implemented.

## 1. Product rules

- **Players**: exactly 2, **deathmatch with monsters**: players spawn at
  the map's deathmatch starts (randomly selected, vanilla
  G_DeathMatchSpawnPlayer, teleport fog and all), carry all keys (key
  pickups don't spawn), and frag each other — the status bar shows frags
  in place of the arms panel. Monsters spawn once per level from the
  single-player THINGS placements and never respawn; a cleared level stays
  clear; a dead player respawns at a free deathmatch start with pistol +
  fists + block gun, without resetting the level. (Solo debug mode uses
  single-player rules: player start, keys spawn and are consumed.)
- **No single-player mode**, no menus/options/automap/savegames/demos-as-a-feature.
- **Levels**: all 32 maps (MAP01–MAP30 + secret MAP31/MAP32, reached via
  secret exits: 15→31, 31→32, 32→16) from a Doom 2-format IWAD, the source
  of truth for geometry, textures, sprites, sounds, and thing placement.
  Game data resolution (src/wad/load.ts): `?wad=<key>` (server-registered
  via `--wad path:key`, key can be secret) → saved menu choice (server
  builtins or the browser's IndexedDB library) → /DOOM2.WAD (dev only) →
  /freedm.wad (freely-distributable default, deathmatch-only maps) →
  interactive picker. Commercial WADs are never committed and never
  served unless explicitly registered; the host's WAD is transferred to
  the joiner through the relay when hashes differ, so both sims are
  byte-identical by construction.
- **Exit**: either player triggering a level exit advances both players to the
  next map. Doom2's text interludes (after MAP06/11/20/30) render as a simple
  text overlay.

## 2. Gameplay fidelity

Gameplay is a faithful TypeScript port of the Chocolate Doom (GPL-2) gameplay
core: 35Hz tics, 16.16 fixed-point integer math, the original state tables
(`info.c`), RNG table (`m_random.c`), physics (`p_map.c`, `p_user.c`), monster
AI (`p_enemy.c`), and weapon logic (`p_pspr.c`).

**Deliberate deviations from vanilla** (GZDoom-style, user-requested):

1. **Jump**: bound key sets `momz = 8*FRACUNIT` when on ground.
2. **Freelook**: mouse pitch; weapons fire along the view pitch with a
   GZDoom-like autoaim assist near targets.

Everything else aims vanilla. Fidelity oracle: DOOM2.WAD's built-in DEMO1–3
replayed through the sim must match a Chocolate Doom reference dump of per-tic
player positions *(planned)*.

## 3. Controls

| Input | Action |
| --- | --- |
| Mouse X / Y (pointer lock) | Turn / look up-down |
| Arrow keys | Keyboard turn / look |
| Esc | Options menu (music/sound volume; Esc releases the mouse, clicking or Resume re-captures) |
| W / S | Forward / back |
| A / D | Strafe left / right |
| Left click | Fire (block gun: place block) |
| Right click | Alt-fire (block gun: remove block) |
| Space | Jump |
| 1–8 | Weapon select (8 = block gun) |
| E | Use (doors, switches) |
| Tab | Automap overlay (+/- to zoom, follows the player) |

## 4. The block gun (weapon 8)

- Always in the player's inventory; survives death; selected like any weapon.
- **Grid**: 32-map-unit cubes on a global 3D grid aligned to the map origin.
  (Player: radius 16, height 56, step-up 24, jump clears ~46 → 1 block is
  jumpable, a 2-stack is an unjumpable wall, a 3-high bridge leaves 64 units
  of walk-under clearance.)
- **Place** (fire): raycast up to 512 units; block appears in the empty cell
  adjacent to the hit face (block/wall/floor hit). Rejected if the cell's AABB
  intersects any solid mobj, or the per-level cap (4096) is reached.
- **Remove** (alt-fire): deletes the targeted block within 512 units.
- **Destructibility**: each block has **35 HP** (3–4 pistol shots at 5–15
  damage). Any hitscan hit or projectile impact damages the block it strikes.
- **Splash through walls**: explosion damage (`P_RadiusAttack`) is traced
  through the grid and attenuated per intervening block *before* those blocks
  are destroyed. Tuning targets: rocket splash fully stopped by 3 blocks of
  depth; BFG destroys all blocks in its radius but ≥4 blocks of depth reduces
  player damage to negligible. All constants live in `src/blocks/tuning.ts`.
- **Physics**: blocks contribute floor/ceiling/wall constraints via vertical
  gap-finding in `P_CheckPosition`; monsters and players collide, stand on
  top, and walk under bridges; removing a supporting block re-runs support
  checks so gravity applies. Blocks block hitscan, projectiles, and monster
  sight (3D DDA). Blocks are per-level and cleared on exit.
- **Jump/climb nuance**: the jump apex is ~36 map units, so a +32 rise
  between block tops is always jumpable, but a grid-aligned block whose
  top sits more than ~36 above a misaligned sector floor is not directly
  jumpable — place a partially-buried block first and stair-step (this is
  also how you pillar up). Blocks may interpenetrate world geometry by
  design.
- **Implementation map**: grid + DDA in `src/blocks/grid.ts`, gun states
  and place/remove in `src/blocks/gun.ts` (psprite states appended after
  the generated table; drawn as a procedural isometric cube in hand), sim wiring in
  `src/blocks/index.ts`, rendering in `src/render/blocksmesh.ts`
  (InstancedMesh, procedural brick texture, damage tint). The grid is part
  of the desync checksum. BFG detonations clear all blocks within a 4-cell
  radius; BFG spray rays lose 25% damage per block of depth (0 at ≥4).

## 5. Networking

- **Model**: delay-based deterministic lockstep at 35Hz with a 3-tic input
  delay (`INPUT_DELAY` in `src/net/client.ts`; adaptive delay is future
  work). Both clients run identical sims; only inputs are exchanged.
- **Wire format**: binary over WebSocket, `[u8 type][u32 tic][payload]`.
  Type 1 = ticcmd (10 bytes: `forwardmove i8, sidemove i8, angleturn i16,
  pitch i16, buttons u8, buttons2 u8 (jump/place/remove), pad u16`); type 2 =
  checksum (u32). Weapon selection travels in `buttons` (vanilla
  BT_CHANGE + 3-bit mask).
- **Server** (`server/main.ts`): single Node process — WebSocket relay with
  4-character room codes plus static hosting of `dist/`. JSON lobby
  (create/join); the game starts automatically when the second player
  joins; WAD hash compared at join — on mismatch the host streams its
  WAD to the joiner over a direct WebRTC DataChannel (64KB chunks;
  server only forwards the SDP/ICE signalling), falling back to
  256KB chunks through the ws relay if no direct path forms within 8s;
  verified by hash, cached in IndexedDB, then start; in-game it relays
  opaque binary frames and holds no game state.
- **Joining**: creator opens `/?server=ws://host:8666&map=N` and shares the
  room code; the other player opens `/?server=ws://host:8666&room=CODE`.
- **Desync detection & recovery**: every 35 tics, FNV-1a checksum over
  leveltime, RNG index, player state, all mobjs in thinker order, sector
  heights, and the block grid (`src/sim/checksum.ts`). On mismatch both
  peers independently rebuild the sim by replaying the retained cmd log
  from game start (determinism makes the log a complete serialization;
  replay runs ~90k tics/sec). A second desync within 30s indicates a
  systematic bug and shows the fatal overlay instead.
- **Stalls**: the sim freezes awaiting the peer's cmd; "waiting for peer"
  overlay after ~350ms; a disconnected peer shows PEER DISCONNECTED.
- **Level transitions** run in lockstep: both sims detect the exit on the
  same tic, show a 105-tic intermission, and load the next map
  deterministically.

## 6. Determinism rules (enforced)

- All sim math is 32-bit integer fixed-point (16.16). `FixedMul` uses 16-bit
  `Math.imul` decomposition (exact int64 semantics); `FixedDiv` uses BigInt.
- Trig/RNG/state tables are code-generated from Chocolate Doom's C source into
  checked-in TypeScript (`npm run gen`) — never computed at runtime.
- ESLint bans `Math.*` (except `imul`), `Date`, `performance`, and any
  renderer/audio/input/net imports inside `src/sim/` and `src/blocks/`.
- No state-affecting iteration over hash maps except in sorted-key order.
- The renderer reads sim state and never writes it; it interpolates between
  tics and applies not-yet-consumed mouse deltas to the camera only.

## 7. Architecture

```
src/wad/     WAD parsing: lumps, palette, textures, flats, sprites, maps, sounds
src/sim/     deterministic gameplay core (ported Chocolate Doom p_*)
src/sim/data/ generated tables (finesine, rndtable, states, mobjinfo, ...)
src/blocks/  voxel grid + block-gun logic (part of the deterministic sim)
src/render/  Three.js renderer (level mesh, sprites, blocks, weapon overlay, HUD)
src/audio/   WebAudio sound effects (DMX → PCM); music deferred
src/input/   pointer lock + keys → ticcmds
src/net/     lockstep client
server/      Node ws relay + lobby + static hosting
tools/       one-off codegen from reference/chocolate-doom C source
```

Licensing: the project is GPL-2 (ported Doom source). `reference/chocolate-doom`
is an untracked read-only clone used by codegen and for porting reference.

## 8. Deferred / out of scope

- OPL-authentic music: music plays via a WebAudio approximation of the
  MUS tracks (`src/audio/music.ts`) — recognizable, not OPL-accurate.
- Demo *recording*, savegames, automap, menus, DeHackEd, screen wipe.
- More than 2 players.
