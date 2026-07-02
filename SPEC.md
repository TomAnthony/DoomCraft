# DoomCraft — Specification

A browser-based Doom 2 for exactly **2 players over the internet**, with an 8th
weapon that places and removes Minecraft-style blocks. This document is the
living specification: it is updated in the same commit as the behavior it
describes. Sections marked *(planned)* are specified but not yet implemented.

## 1. Product rules

- **Players**: exactly 2, cooperative-hostile ("deathmatch with monsters"):
  monsters spawn once per level from the single-player THINGS placements and
  never respawn; players can damage each other (vanilla co-op friendly fire);
  a cleared level stays clear; a dead player respawns at a player start with
  pistol + fists + block gun, without resetting the level.
- **No single-player mode**, no menus/options/automap/savegames/demos-as-a-feature.
- **Levels**: all 32 maps (MAP01–MAP30 + secret MAP31/MAP32, reached via
  secret exits: 15→31, 31→32, 32→16) from the user's own `DOOM2.WAD`, which is the source
  of truth for geometry, textures, sprites, sounds, and thing placement. The
  WAD is never committed, bundled, served publicly, or transmitted between
  players — each player supplies their own local copy, verified identical by
  hash in the lobby.
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
| W / S | Forward / back |
| A / D | Strafe left / right |
| Left click | Fire (block gun: place block) |
| Right click | Alt-fire (block gun: remove block) |
| Space | Jump |
| 1–8 | Weapon select (8 = block gun) |
| E | Use (doors, switches) |

## 4. The block gun (weapon 8) *(planned — M6)*

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

## 5. Networking *(planned — M5)*

- **Model**: delay-based deterministic lockstep at 35Hz, 3-tic input delay
  (adaptive 1–5 from RTT). Both clients run identical sims; only inputs are
  exchanged.
- **ticcmd (10 bytes)**: `forwardmove i8, sidemove i8, angleturn i16,
  pitch i16, buttons u8, buttons2 u8 (jump/place/remove), weapon u8, pad u8`.
  Wire frame: `[u32 tic][ticcmd]` binary over WebSocket.
- **Server**: single Node process — WebSocket relay with 4-character room
  codes plus static file hosting. JSON lobby messages (create/join/start);
  WAD hash compared at join, mismatch refused; in-game it relays opaque
  binary frames and holds no game state.
- **Desync detection**: every 35 tics, FNV-1a checksum over RNG index, player
  state, all mobjs in thinker order, sector heights, and the block-grid hash.
  Mismatch → full snapshot resync from player 1; two failures → back to lobby.
- **Stalls**: sim freezes awaiting the peer's cmd; overlay after ~350ms;
  disconnect after 10s.

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

- Music playback (MUS → synth) — deferred; sound effects are in scope.
- Demo *recording*, savegames, automap, menus, DeHackEd, screen wipe.
- More than 2 players.
