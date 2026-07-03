// Lockstep netplay client. Delay-based deterministic lockstep at 35Hz:
// each side sends only its ticcmds (10 bytes + header); the sim advances
// when both players' cmds for the next tic are buffered. FNV checksums
// exchanged every 35 tics detect desync.
//
// Transport is hybrid: cmds prefer a direct WebRTC DataChannel
// (reliable, UNORDERED — cmds are tic-keyed so order is irrelevant and
// this avoids TCP-style head-of-line blocking), with the ws relay as
// fallback. While on RTC, every 35th cmd also goes via the relay as a
// heartbeat: the receiver dedups by tic, and a heartbeat arriving while
// the RTC copy is >1s behind is the demotion tripwire. Demotion is a
// one-way ratchet (rtc → dual → relay, no mid-game promotion): the
// receive side needs zero switching logic because all paths feed the
// same tic-keyed map. Checksums and control stay on the ws.

import { simChecksum } from '../sim/checksum.ts';
import type { DoomSim } from '../sim/sim.ts';
import { hashWad } from '../wad/wad.ts';
import { decodeCmd, emptyCmd, encodeCmd, TICCMD_BYTES, type TicCmd } from '../sim/ticcmd.ts';

// Binary frames: [u8 type][u8 slot][...payload]. For CMD/CHECKSUM the
// slot is the SENDER (server broadcasts to everyone else); for WAD
// META/CHUNK it's the TARGET (server routes to that one peer).
const MSG_CMD = 1;
const MSG_CHECKSUM = 2;
const MSG_WAD_META = 3;
const MSG_WAD_CHUNK = 4;
const WAD_CHUNK_SIZE = 256 * 1024;
const MAX_NET_PLAYERS = 4;

export const INPUT_DELAY = 3; // tics (~86ms)

export interface LobbyResult {
  slot: number;
  map: number;
  skill: number;
  room: string;
  /** number of players in the game (2-4) */
  players: number;
  /** host rule: block gun available in this netgame */
  blockGun: boolean;
  /** set when the host transferred its WAD to us during the lobby */
  receivedWad?: ArrayBuffer;
}

export interface ConnectOptions {
  room?: string;
  map?: number;
  /** display name (max 12 chars; empty = server assigns "Player N") */
  name?: string;
  /** host rule (create only): allow the block gun */
  blockGun?: boolean;
  /** null = we have no WAD; the host will send one */
  wadHash: string | null;
  /** host side: supplies the bytes to stream on peerNeedsWad */
  wadProvider?: () => ArrayBuffer;
  onWadProgress?: (got: number, total: number) => void;
  /** lobby roster updates: players present / WAD-ready / display names */
  onRoster?: (count: number, ready: number, names: string[]) => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  /** cmds[player][tic] */
  private readonly cmds: Map<number, TicCmd>[] = [new Map(), new Map(), new Map(), new Map()];
  private readonly localChecksums = new Map<number, number>();
  /** remoteChecksums[slot]: tic -> sum */
  private readonly remoteChecksums: Map<number, number>[] = [
    new Map(), new Map(), new Map(), new Map(),
  ];
  slot = 0;
  /** number of players once the game starts */
  playerCount = 2;
  /** display names per slot (from the lobby; presentational only) */
  names: string[] = [];
  room = '';
  /** next tic to simulate */
  simTic = 0;
  /** next local tic to generate input for */
  sendTic = 0;
  desync: number | null = null;
  peerLeft = false;
  /** slot -> first tic WITHOUT that player's cmd (server-arbitrated) */
  readonly departures = new Map<number, number>();
  /** UI callback: a player left mid-game */
  onPlayerLeft: ((slot: number) => void) | null = null;

  /** smoothed ws relay round-trip, ms (-1 until measured) */
  rttMs = -1;
  private pingN = 0;
  private pingSent = new Map<number, number>();

  private wadIncoming: { buf: Uint8Array; got: number } | null = null;
  private receivedWad: ArrayBuffer | null = null;
  private onWadProgress: ((got: number, total: number) => void) | null = null;

  /** Connect and run the lobby: create a room or join one. */
  connect(url: string, opts: ConnectOptions): Promise<LobbyResult> {
    this.onWadProgress = opts.onWadProgress ?? null;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onerror = () => reject(new Error(`cannot reach server ${url}`));
      ws.onopen = () => {
        if (opts.room) {
          ws.send(
            JSON.stringify({ t: 'join', room: opts.room, wadHash: opts.wadHash, name: opts.name }),
          );
        } else {
          ws.send(
            JSON.stringify({
              t: 'create',
              map: opts.map ?? 1,
              wadHash: opts.wadHash,
              blockGun: opts.blockGun ?? true,
              name: opts.name,
            }),
          );
        }
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          this.onBinary(new DataView(ev.data as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(ev.data);
        if (msg.t === 'created') {
          this.room = msg.room;
        } else if (msg.t === 'start') {
          this.slot = msg.slot;
          this.playerCount = msg.players ?? 2;
          this.names = msg.names ?? [];
          // relay RTT probe (debug panel; ~2s cadence, trivial traffic)
          setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              const n = this.pingN++;
              this.pingSent.set(n, performance.now());
              this.ws.send(JSON.stringify({ t: 'ping', n }));
              if (this.pingSent.size > 10) this.pingSent.clear(); // lost pings
            }
          }, 2000);
          // RTC cmd transport is 2-player only for now (3-4 players run
          // relay-first; a per-pair mesh is future work). The host offers
          // the persistent in-game cmd channel.
          if (msg.slot === 0 && this.playerCount === 2) void this.openGameChannel(1);
          resolve({
            slot: msg.slot,
            map: msg.map,
            skill: msg.skill,
            room: this.room,
            players: this.playerCount,
            blockGun: msg.blockGun !== false,
            receivedWad: this.receivedWad ?? undefined,
          });
        } else if (msg.t === 'peerNeedsWad') {
          if (opts.wadProvider) void this.transferWad(opts.wadProvider(), msg.slot ?? 1);
        } else if (msg.t === 'awaitWad') {
          this.onWadProgress?.(0, 0); // "waiting for host…"
        } else if (msg.t === 'roster') {
          this.names = msg.names ?? this.names;
          opts.onRoster?.(msg.count, msg.ready, msg.names ?? []);
        } else if (msg.t === 'rtc') {
          void this.onRtcSignal(msg.d, msg.from ?? 0);
        } else if (msg.t === 'error') {
          reject(new Error(msg.reason));
        } else if (msg.t === 'pong') {
          const t0 = this.pingSent.get(msg.n);
          if (t0 !== undefined) {
            this.pingSent.delete(msg.n);
            const rtt = performance.now() - t0;
            this.rttMs = this.rttMs < 0 ? rtt : this.rttMs * 0.7 + rtt * 0.3;
          }
        } else if (msg.t === 'playerLeft') {
          // dropout-and-continue: survivors drop the player at the
          // agreed tic (clamped forward if we already simulated past it
          // via the RTC fast path — only possible with no peers left to
          // disagree with)
          this.departures.set(msg.slot, Math.max(msg.tic, this.simTic));
          this.onPlayerLeft?.(msg.slot);
          if (msg.slot === (this.slot ^ 1) && this.playerCount === 2) {
            // our RTC partner is gone; make sure we're relay-only
            this.demotePath('peer left', true);
          }
        } else if (msg.t === 'peerleft') {
          this.peerLeft = true;
        }
      };
    });
  }

  // --- WAD transfer ---------------------------------------------------------
  // Preferred path: a direct WebRTC DataChannel (host→joiner, peer to
  // peer — the 14-22MB never touches the relay; the server only forwards
  // the few hundred bytes of SDP/ICE signalling). Falls back to relaying
  // through the WebSocket when a direct connection can't be established
  // (e.g. symmetric NATs) within the timeout.

  /** per-peer connections (WAD transfers + the 2-player game channel) */
  private readonly rtcPeers = new Map<
    number,
    { pc: RTCPeerConnection; pendingCands: RTCIceCandidateInit[] }
  >();

  private signal(to: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ t: 'rtc', to, d }));
  }

  /** Host side: try direct WebRTC to one joiner, fall back to the relay. */
  private async transferWad(buf: ArrayBuffer, target: number): Promise<void> {
    const viaRtc = await this.tryRtcSend(buf, target, 8000);
    if (!viaRtc) {
      console.info(`WAD transfer: WebRTC unavailable, using relay fallback (slot ${target})`);
      await this.sendWad(buf, target);
    }
    this.rtcPeers.get(target)?.pc.close();
    this.rtcPeers.delete(target);
  }

  private tryRtcSend(buf: ArrayBuffer, target: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let opened = false;
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        this.rtcPeers.set(target, { pc, pendingCands: [] });
        const dc = pc.createDataChannel('wad');
        dc.binaryType = 'arraybuffer';
        const timer = setTimeout(() => {
          if (!opened) {
            try {
              pc.close();
            } catch {
              // ignore
            }
            resolve(false);
          }
        }, timeoutMs);
        dc.onopen = () => {
          opened = true;
          clearTimeout(timer);
          console.info(`WAD transfer: direct WebRTC channel open (slot ${target})`);
          this.streamOverChannel(dc, buf, target).then(
            () => resolve(true),
            () => resolve(false), // mid-stream failure → relay resends from scratch
          );
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) this.signal(target, { cand: e.candidate });
        };
        void pc
          .createOffer()
          .then((o) => pc.setLocalDescription(o))
          .then(() => this.signal(target, { sdp: pc.localDescription }));
      } catch {
        resolve(false);
      }
    });
  }

  /** Answer offers / apply answers+candidates, per peer ('from'). */
  private async onRtcSignal(
    d: {
      sdp?: RTCSessionDescriptionInit;
      cand?: RTCIceCandidateInit;
      hint?: string;
    },
    from: number,
  ): Promise<void> {
    try {
      if (d.hint === 'demote') {
        if (this.path !== 'relay') this.demotePath('peer hint');
        return;
      }
      if (d.sdp?.type === 'offer') {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        const entry = { pc, pendingCands: [] as RTCIceCandidateInit[] };
        this.rtcPeers.get(from)?.pc.close();
        this.rtcPeers.set(from, entry);
        pc.ondatachannel = (e) => {
          if (e.channel.label === 'game') {
            // joiner side of the persistent in-game cmd channel
            this.gamePc = pc;
            this.wireGameChannel(e.channel);
            return;
          }
          e.channel.binaryType = 'arraybuffer';
          e.channel.onmessage = (ev) => this.onBinary(new DataView(ev.data as ArrayBuffer));
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) this.signal(from, { cand: e.candidate });
        };
        await pc.setRemoteDescription(d.sdp);
        for (const c of entry.pendingCands.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(from, { sdp: pc.localDescription });
      } else if (d.sdp?.type === 'answer') {
        const entry = this.rtcPeers.get(from);
        if (!entry) return;
        await entry.pc.setRemoteDescription(d.sdp);
        for (const c of entry.pendingCands.splice(0)) {
          await entry.pc.addIceCandidate(c).catch(() => {});
        }
      } else if (d.cand) {
        const entry = this.rtcPeers.get(from);
        if (!entry) return;
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(d.cand).catch(() => {});
        else entry.pendingCands.push(d.cand);
      }
    } catch {
      // direct path failed — the host's timeout triggers the relay fallback
    }
  }

  private wadMeta(target: number, size: number): ArrayBuffer {
    const meta = new DataView(new ArrayBuffer(6));
    meta.setUint8(0, MSG_WAD_META);
    meta.setUint8(1, target);
    meta.setUint32(2, size, true);
    return meta.buffer;
  }

  private wadChunk(target: number, buf: ArrayBuffer, off: number, size: number): ArrayBuffer {
    const chunk = buf.slice(off, Math.min(off + size, buf.byteLength));
    const frame = new Uint8Array(6 + chunk.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint8(0, MSG_WAD_CHUNK);
    view.setUint8(1, target);
    view.setUint32(2, off, true);
    frame.set(new Uint8Array(chunk), 6);
    return frame.buffer;
  }

  /** Stream meta+chunks over a DataChannel (64KB frames, backpressured). */
  private async streamOverChannel(
    dc: RTCDataChannel,
    buf: ArrayBuffer,
    target: number,
  ): Promise<void> {
    const CHUNK = 65536; // all current browsers accept 64KB DataChannel messages
    dc.send(this.wadMeta(target, buf.byteLength));
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      while (dc.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      }
      dc.send(this.wadChunk(target, buf, off, CHUNK));
    }
    // drain before the caller closes the connection — anything left in
    // bufferedAmount would be silently dropped with the tail unsent
    while (dc.bufferedAmount > 0 && dc.readyState === 'open') {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Relay fallback: stream the WAD through the WebSocket server. */
  private async sendWad(buf: ArrayBuffer, target: number): Promise<void> {
    const ws = this.ws!;
    ws.send(this.wadMeta(target, buf.byteLength));
    for (let off = 0; off < buf.byteLength; off += WAD_CHUNK_SIZE) {
      // backpressure: don't queue the whole file into the socket buffer
      while (ws.bufferedAmount > 4 * WAD_CHUNK_SIZE) {
        await new Promise((r) => setTimeout(r, 25));
      }
      ws.send(this.wadChunk(target, buf, off, WAD_CHUNK_SIZE));
    }
  }

  private onBinary(view: DataView, src: 'ws' | 'rtc' = 'ws'): void {
    const type = view.getUint8(0);
    const slot = view.getUint8(1); // sender (cmd/checksum) or target (wad)
    if (type === MSG_CMD) {
      if (slot === this.slot || slot >= MAX_NET_PLAYERS) return;
      const tic = view.getUint32(2, true);
      this.cmds[slot]!.set(tic, decodeCmd(view, 6)); // dedup by (slot, tic)
      if (src === 'rtc') {
        this.highTicRtc = Math.max(this.highTicRtc, tic);
      } else {
        this.highTicRelay = Math.max(this.highTicRelay, tic);
        // tripwire: a relay heartbeat a full second ahead of anything the
        // RTC path has delivered means the direct path is stalling
        if (this.path === 'rtc' && this.highTicRtc >= 0 && tic - this.highTicRtc > 35) {
          this.demotePath('RTC receive stalled behind relay heartbeat');
        }
      }
    } else if (type === MSG_CHECKSUM) {
      if (slot >= MAX_NET_PLAYERS) return;
      this.remoteChecksums[slot]!.set(view.getUint32(2, true), view.getUint32(6, true));
    } else if (type === MSG_WAD_META) {
      this.wadIncoming = {
        buf: new Uint8Array(new ArrayBuffer(view.getUint32(2, true))),
        got: 0,
      };
    } else if (type === MSG_WAD_CHUNK && this.wadIncoming) {
      const off = view.getUint32(2, true);
      const data = new Uint8Array(view.buffer, view.byteOffset + 6, view.byteLength - 6);
      this.wadIncoming.buf.set(data, off);
      this.wadIncoming.got += data.byteLength;
      this.onWadProgress?.(this.wadIncoming.got, this.wadIncoming.buf.byteLength);
      if (this.wadIncoming.got >= this.wadIncoming.buf.byteLength) {
        const done = this.wadIncoming.buf.buffer as ArrayBuffer;
        this.wadIncoming = null;
        this.receivedWad = done;
        void hashWad(done).then((wadHash) =>
          this.ws?.send(JSON.stringify({ t: 'wadReady', wadHash })),
        );
      }
    }
  }

  // --- hybrid cmd transport -------------------------------------------------

  /** 'rtc' = DataChannel + relay heartbeat; 'dual' = both (grace window
   *  after trouble); 'relay' = ws only (terminal for this game). */
  path: 'relay' | 'rtc' | 'dual' = 'relay';
  private gamePc: RTCPeerConnection | null = null;
  private gameDc: RTCDataChannel | null = null;
  private highTicRtc = -1;
  private highTicRelay = -1;

  /** Host side: offer the persistent unordered in-game cmd channel
   *  (2-player games only; 3-4 players are relay-first for now). */
  private async openGameChannel(target: number): Promise<void> {
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      this.gamePc = pc;
      this.rtcPeers.get(target)?.pc.close();
      this.rtcPeers.set(target, { pc, pendingCands: [] });
      const dc = pc.createDataChannel('game', { ordered: false });
      this.wireGameChannel(dc);
      pc.onicecandidate = (e) => {
        if (e.candidate) this.signal(target, { cand: e.candidate });
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal(target, { sdp: pc.localDescription });
    } catch {
      // stays on relay
    }
  }

  private wireGameChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      if (this.path === 'relay' && this.gameDc === dc) {
        this.path = 'rtc';
        console.info('game path: direct WebRTC (relay heartbeat 1/s)');
      }
    };
    dc.onmessage = (ev) => this.onBinary(new DataView(ev.data as ArrayBuffer), 'rtc');
    dc.onclose = () => {
      if (this.gameDc === dc && this.path !== 'relay') this.demotePath('channel closed', true);
    };
    dc.onerror = () => {
      if (this.gameDc === dc) this.demotePath('channel error', true);
    };
    this.gameDc = dc;
  }

  /** One-way ratchet: rtc → dual (10s grace) → relay. */
  private demotePath(reason: string, terminal = false): void {
    if (this.path === 'relay') return;
    console.info(`game path: demoting (${reason})${terminal ? ' → relay' : ' → dual'}`);
    // cover any cmds lost in RTC flight: replay recent ones over the relay
    for (let t = Math.max(0, this.sendTic - 35); t < this.sendTic; t++) {
      const c = this.cmds[this.slot]!.get(t);
      if (c) this.ws?.send(this.encodeFrame(t, c));
    }
    // hint the peer so both sides converge quickly (2-player path)
    this.signal(this.slot ^ 1, { hint: 'demote' });
    if (terminal) {
      this.path = 'relay';
      try {
        this.gamePc?.close();
      } catch {
        // ignore
      }
      this.gameDc = null;
      return;
    }
    this.path = 'dual';
    setTimeout(() => {
      if (this.path === 'dual') {
        this.path = 'relay';
        console.info('game path: relay (grace window over)');
        try {
          this.gamePc?.close();
        } catch {
          // ignore
        }
        this.gameDc = null;
      }
    }, 10_000);
  }

  private encodeFrame(tic: number, cmd: TicCmd): ArrayBuffer {
    const buf = new ArrayBuffer(6 + TICCMD_BYTES);
    const view = new DataView(buf);
    view.setUint8(0, MSG_CMD);
    view.setUint8(1, this.slot);
    view.setUint32(2, tic, true);
    encodeCmd(view, 6, cmd);
    return buf;
  }

  /** Queue the local cmd for sendTic and transmit it. */
  pushLocalCmd(cmd: TicCmd): void {
    const tic = this.sendTic++;
    this.cmds[this.slot]!.set(tic, cmd);
    const frame = this.encodeFrame(tic, cmd);

    const dcOpen = this.gameDc?.readyState === 'open';
    if ((this.path === 'rtc' || this.path === 'dual') && dcOpen) {
      // >64KB of 15B cmds queued means the channel is wedged
      if (this.gameDc!.bufferedAmount > 65536) {
        this.demotePath('send buffer wedged');
      } else {
        try {
          this.gameDc!.send(frame);
        } catch {
          this.demotePath('send failed', true);
        }
      }
    }
    // relay carries: everything when not on rtc, else a 1/s heartbeat
    if (this.path !== 'rtc' || tic % 35 === 0) {
      this.ws?.send(frame);
    }
  }

  private allHave(tic: number): boolean {
    for (let i = 0; i < this.playerCount; i++) {
      const gone = this.departures.get(i);
      if (gone !== undefined && tic >= gone) continue; // departed: no cmd needed
      if (i === this.slot && tic < this.sendTic) continue; // our own cmds always exist
      if (!this.cmds[i]!.has(tic)) return false;
    }
    return true;
  }

  /** Every player's cmd available for the next tic? */
  canAdvance(): boolean {
    return this.allHave(this.simTic) && this.desync === null;
  }

  /** Consecutive future tics for which all cmds are already buffered. */
  bufferedAhead(): number {
    let n = 0;
    while (this.allHave(this.simTic + n)) n++;
    return n;
  }

  /** Run one lockstep tic. Returns the tic number just simulated.
   *  Cmds are retained — the full log is the game's serialization and
   *  powers replay-based desync recovery. */
  advance(sim: DoomSim): number {
    const tic = this.simTic;
    // apply server-arbitrated departures exactly at their tic — part of
    // the deterministic input sequence, identical on every survivor
    for (const [slot, dropTic] of this.departures) {
      if (dropTic === tic) sim.dropPlayer(slot);
    }
    const cmds: TicCmd[] = [];
    for (let i = 0; i < MAX_NET_PLAYERS; i++) {
      cmds.push(i < this.playerCount ? (this.cmds[i]!.get(tic) ?? emptyCmd()) : emptyCmd());
    }
    sim.runTic(cmds);
    this.simTic++;

    // checksum exchange every 35 tics (broadcast; everyone compares all)
    if (tic % 35 === 0) {
      const sum = simChecksum(sim);
      this.localChecksums.set(tic, sum);
      const buf = new ArrayBuffer(10);
      const view = new DataView(buf);
      view.setUint8(0, MSG_CHECKSUM);
      view.setUint8(1, this.slot);
      view.setUint32(2, tic, true);
      view.setUint32(6, sum, true);
      this.ws?.send(buf);
    }
    this.compareChecksums();
    return tic;
  }

  private compareChecksums(): void {
    for (let s = 0; s < this.playerCount; s++) {
      if (s === this.slot || this.departures.has(s)) continue;
      for (const [tic, remote] of this.remoteChecksums[s]!) {
        const local = this.localChecksums.get(tic);
        if (local === undefined) continue;
        if (local !== remote) this.desync = tic;
        this.remoteChecksums[s]!.delete(tic);
      }
    }
    // prune local sums everyone has consumed (keep the last few)
    for (const tic of this.localChecksums.keys()) {
      if (tic < this.simTic - 35 * 10) this.localChecksums.delete(tic);
    }
  }

  /** Display name for a slot ("Player N" fallback). */
  nameOf(slot: number): string {
    return this.names[slot] || `Player ${slot + 1}`;
  }

  /** Host: start the game with the players currently in the room. */
  begin(): void {
    this.ws?.send(JSON.stringify({ t: 'begin' }));
  }

  /** Cmd from the retained log (replay-based resync). */
  getCmd(player: number, tic: number): TicCmd {
    return this.cmds[player]!.get(tic) ?? emptyCmd();
  }

  /**
   * Total view turn sitting in local cmds that are sent but not yet
   * simulated (BAM). The camera adds this on top of mo.angle — without
   * it, every turn disappears for INPUT_DELAY tics after being consumed
   * from the mouse accumulator, which reads as severe look jitter.
   */
  pendingLocalTurn(): { yaw: number; pitch: number } {
    let yaw = 0;
    let pitch = 0;
    for (let t = this.simTic; t < this.sendTic; t++) {
      const c = this.cmds[this.slot]!.get(t);
      if (c) {
        yaw = (yaw + (c.angleturn << 16)) | 0;
        pitch = (pitch + (c.pitch << 16)) | 0;
      }
    }
    return { yaw, pitch };
  }

  /** Snapshot of transport health for the debug panel. */
  stats(): Record<string, unknown> {
    return {
      slot: this.slot,
      players: this.playerCount,
      path: this.path,
      simTic: this.simTic,
      sendTic: this.sendTic,
      ahead: this.bufferedAhead(),
      rttMs: this.rttMs < 0 ? null : Math.round(this.rttMs),
      rtcHighTic: this.highTicRtc,
      relayHighTic: this.highTicRelay,
      departures: [...this.departures.entries()],
      desyncTic: this.desync,
    };
  }

  /** Clear desync state after a successful replay resync. */
  clearDesync(): void {
    this.desync = null;
    this.localChecksums.clear();
    for (const m of this.remoteChecksums) m.clear();
  }

  close(): void {
    this.ws?.close();
  }
}
