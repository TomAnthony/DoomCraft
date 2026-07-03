# DoomCraft — TODO

Living list of known gaps and potential future work. Items get struck through (or
removed) as they land; anything sizeable also gets a SPEC.md update.

## Correctness / robustness

- [ ] **Demo-replay fidelity oracle** — replay DOOM2.WAD's built-in
      DEMO1–3 through the sim and diff per-tic player positions against a
      Chocolate Doom reference dump. The gold-standard proof that gameplay
      is vanilla-identical (determinism canaries pass, but this pins
      fidelity, not just self-consistency).
- [ ] **Mid-game rejoin** — a disconnected player should be able to rejoin:
      needs relay-server room persistence across a disconnect plus sending
      the full cmd log to the rejoining peer (the replay-based resync
      machinery, added 2026-07-02, already reconstructs state from the log).
- [ ] **Adaptive input delay** — the 3-tic lockstep delay is fixed; measure
      RTT and use 1–5.
- [ ] **Sim in a Web Worker (Option B)** — the worker-clock watchdog keeps
      the game ticking in backgrounded windows, but the sim still runs on
      the main thread. Moving DoomSim + the WebSocket into a dedicated
      worker (renderer consumes posted snapshots) would make netplay fully
      immune to main-thread jank; requires a serialization boundary for
      the renderer's direct mobj/sector access.
- [ ] **Client-side movement prediction** — with lockstep, your own
      movement echoes ~86ms late (aim is latency-free, walking isn't).
      Prediction would remove the "swimming" feel on real internet links.

- [ ] **RTC mesh for 3-4 players** — multiplayer cmds are relay-only for
      3-4 players (2-player games use the RTC hybrid). A per-pair
      DataChannel mesh with per-link demotion would cut relay traffic
      and latency; the tic-keyed dedup already tolerates mixed paths,
      and checksum majority-voting could pinpoint which client diverged.

## Gameplay / polish

- [ ] **Doom 2 story interludes** — the text screens after MAP06/11/20/30
      (currently only the generic tally overlay shows).
- [ ] **OPL-authentic music** — current music is a WebAudio approximation
      of the MUS tracks; a real OPL2/DBOPL emulation would nail the sound.
- [ ] **Crosshair option for all weapons** (currently block gun only).
- [ ] **Block-gun hand sprite** — the procedural cube could become a
      proper drawn hand-holding-block sprite.
- [ ] **Autoaim vs blocks** — autoaim can acquire targets through block
      walls (the shot still hits the block; purely a targeting nicety).

## Done recently (2026-07-03)

- [x] Hybrid cmd transport: direct WebRTC DataChannel (unordered) with
      relay heartbeat + one-way demotion ratchet (rtc → dual → relay);
      WAD transfers also peer-to-peer with relay fallback
- [x] WAD system: FreeDM default, menu picker/upload, host→joiner
      transfer, --wad path:key private server WADs
- [x] Start menu, copyable invite link, automap (Tab), 4:3 aspect
      option, single-port hosting, stale-build tripwire, server
      hardening + load test (1000 players ≈ 34.5k msg/s, p99 4.7ms)

## Done recently (playtest round, 2026-07-02)

- [x] Desync recovery: replay-based resync — peers keep the full cmd log
      and rebuild the sim from game start on checksum mismatch (~90k
      tics/sec; verified by corrupting one peer live and watching both
      reconverge). Two desyncs within 30s → fatal (systematic bug).
- [x] Player 2 palette translation (indigo/gray, vanilla ramp remap)
- [x] Mouse sensitivity slider in options
- [x] Blocks shaded by sector light (were full-bright)
- [x] Music pass 2: loop boundary killed lingering notes (the "weird
      after a few minutes" drone), note-offs at musical time, voice cap

- [x] Deathmatch mode proper: DM spawn points, all keys, frags panel,
      30s weapon/item respawn
- [x] GZDoom-style air control (ledge jumps)
- [x] Vanilla per-origin sound channels (chainsaw cutoff)
- [x] Keys always stay in the world (persistent-level softlock)
- [x] Status bar with offset-correct mugshot; block target crosshair
- [x] Netplay advancement pacing (view stutter)
- [x] Music synth evenness (detuned presets double-loud, live volume
      fades, percussion channel volume, bus compressor)
