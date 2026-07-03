// Lockstep netplay client. Delay-based deterministic lockstep at 35Hz:
// each side sends only its ticcmds (10 bytes + header); the sim advances
// when both players' cmds for the next tic are buffered. FNV checksums
// exchanged every 35 tics detect desync.

import { simChecksum } from '../sim/checksum.ts';
import type { DoomSim } from '../sim/sim.ts';
import { hashWad } from '../wad/wad.ts';
import { decodeCmd, emptyCmd, encodeCmd, TICCMD_BYTES, type TicCmd } from '../sim/ticcmd.ts';

const MSG_CMD = 1;
const MSG_CHECKSUM = 2;
const MSG_WAD_META = 3;
const MSG_WAD_CHUNK = 4;
const WAD_CHUNK_SIZE = 256 * 1024;

export const INPUT_DELAY = 3; // tics (~86ms)

export interface LobbyResult {
  slot: number;
  map: number;
  skill: number;
  room: string;
  /** set when the host transferred its WAD to us during the lobby */
  receivedWad?: ArrayBuffer;
}

export interface ConnectOptions {
  room?: string;
  map?: number;
  /** null = we have no WAD; the host will send one */
  wadHash: string | null;
  /** host side: supplies the bytes to stream on peerNeedsWad */
  wadProvider?: () => ArrayBuffer;
  onWadProgress?: (got: number, total: number) => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  /** cmds[player][tic] */
  private readonly cmds: Map<number, TicCmd>[] = [new Map(), new Map()];
  private readonly localChecksums = new Map<number, number>();
  private readonly remoteChecksums = new Map<number, number>();
  slot = 0;
  room = '';
  /** next tic to simulate */
  simTic = 0;
  /** next local tic to generate input for */
  sendTic = 0;
  desync: number | null = null;
  peerLeft = false;

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
          ws.send(JSON.stringify({ t: 'join', room: opts.room, wadHash: opts.wadHash }));
        } else {
          ws.send(JSON.stringify({ t: 'create', map: opts.map ?? 1, wadHash: opts.wadHash }));
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
          resolve({
            slot: msg.slot,
            map: msg.map,
            skill: msg.skill,
            room: this.room,
            receivedWad: this.receivedWad ?? undefined,
          });
        } else if (msg.t === 'peerNeedsWad') {
          if (opts.wadProvider) void this.transferWad(opts.wadProvider());
        } else if (msg.t === 'awaitWad') {
          this.onWadProgress?.(0, 0); // "waiting for host…"
        } else if (msg.t === 'rtc') {
          void this.onRtcSignal(msg.d);
        } else if (msg.t === 'error') {
          reject(new Error(msg.reason));
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

  private rtcPc: RTCPeerConnection | null = null;
  private pendingCands: RTCIceCandidateInit[] = [];

  /** Host side: try direct WebRTC, fall back to the relay. */
  private async transferWad(buf: ArrayBuffer): Promise<void> {
    const viaRtc = await this.tryRtcSend(buf, 8000);
    if (!viaRtc) {
      console.info('WAD transfer: WebRTC unavailable, using relay fallback');
      await this.sendWad(buf);
    }
    this.rtcPc?.close();
    this.rtcPc = null;
  }

  private tryRtcSend(buf: ArrayBuffer, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let opened = false;
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        this.rtcPc = pc;
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
          console.info('WAD transfer: direct WebRTC channel open');
          this.streamOverChannel(dc, buf).then(
            () => resolve(true),
            () => resolve(false), // mid-stream failure → relay resends from scratch
          );
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) this.ws?.send(JSON.stringify({ t: 'rtc', d: { cand: e.candidate } }));
        };
        void pc
          .createOffer()
          .then((o) => pc.setLocalDescription(o))
          .then(() => this.ws?.send(JSON.stringify({ t: 'rtc', d: { sdp: pc.localDescription } })));
      } catch {
        resolve(false);
      }
    });
  }

  /** Joiner side: answer the host's offer; channel frames feed the same
   *  assembler as relay frames. */
  private async onRtcSignal(d: {
    sdp?: RTCSessionDescriptionInit;
    cand?: RTCIceCandidateInit;
  }): Promise<void> {
    try {
      if (d.sdp?.type === 'offer') {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        this.rtcPc = pc;
        pc.ondatachannel = (e) => {
          e.channel.binaryType = 'arraybuffer';
          e.channel.onmessage = (ev) => this.onBinary(new DataView(ev.data as ArrayBuffer));
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) this.ws?.send(JSON.stringify({ t: 'rtc', d: { cand: e.candidate } }));
        };
        await pc.setRemoteDescription(d.sdp);
        for (const c of this.pendingCands.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.ws?.send(JSON.stringify({ t: 'rtc', d: { sdp: pc.localDescription } }));
      } else if (d.sdp?.type === 'answer') {
        await this.rtcPc?.setRemoteDescription(d.sdp);
        for (const c of this.pendingCands.splice(0)) {
          await this.rtcPc?.addIceCandidate(c).catch(() => {});
        }
      } else if (d.cand) {
        if (this.rtcPc?.remoteDescription) await this.rtcPc.addIceCandidate(d.cand).catch(() => {});
        else this.pendingCands.push(d.cand);
      }
    } catch {
      // direct path failed — the host's timeout triggers the relay fallback
    }
  }

  /** Stream meta+chunks over a DataChannel (16KB frames, backpressured). */
  private async streamOverChannel(dc: RTCDataChannel, buf: ArrayBuffer): Promise<void> {
    const CHUNK = 65536; // all current browsers accept 64KB DataChannel messages
    const meta = new DataView(new ArrayBuffer(5));
    meta.setUint8(0, MSG_WAD_META);
    meta.setUint32(1, buf.byteLength, true);
    dc.send(meta.buffer);
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      while (dc.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const chunk = buf.slice(off, Math.min(off + CHUNK, buf.byteLength));
      const frame = new Uint8Array(5 + chunk.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint8(0, MSG_WAD_CHUNK);
      view.setUint32(1, off, true);
      frame.set(new Uint8Array(chunk), 5);
      dc.send(frame.buffer);
    }
    // drain before the caller closes the connection — anything left in
    // bufferedAmount would be silently dropped with the tail unsent
    while (dc.bufferedAmount > 0 && dc.readyState === 'open') {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Relay fallback: stream the WAD through the WebSocket server. */
  private async sendWad(buf: ArrayBuffer): Promise<void> {
    const ws = this.ws!;
    const meta = new DataView(new ArrayBuffer(5));
    meta.setUint8(0, MSG_WAD_META);
    meta.setUint32(1, buf.byteLength, true);
    ws.send(meta.buffer);
    for (let off = 0; off < buf.byteLength; off += WAD_CHUNK_SIZE) {
      // backpressure: don't queue the whole file into the socket buffer
      while (ws.bufferedAmount > 4 * WAD_CHUNK_SIZE) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const chunk = buf.slice(off, Math.min(off + WAD_CHUNK_SIZE, buf.byteLength));
      const frame = new Uint8Array(5 + chunk.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint8(0, MSG_WAD_CHUNK);
      view.setUint32(1, off, true);
      frame.set(new Uint8Array(chunk), 5);
      ws.send(frame.buffer);
    }
  }

  private onBinary(view: DataView): void {
    const type = view.getUint8(0);
    if (type === MSG_CMD) {
      this.cmds[this.slot ^ 1]!.set(view.getUint32(1, true), decodeCmd(view, 5));
    } else if (type === MSG_CHECKSUM) {
      this.remoteChecksums.set(view.getUint32(1, true), view.getUint32(5, true));
    } else if (type === MSG_WAD_META) {
      this.wadIncoming = {
        buf: new Uint8Array(new ArrayBuffer(view.getUint32(1, true))),
        got: 0,
      };
    } else if (type === MSG_WAD_CHUNK && this.wadIncoming) {
      const off = view.getUint32(1, true);
      const data = new Uint8Array(view.buffer, view.byteOffset + 5, view.byteLength - 5);
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

  /** Queue the local cmd for sendTic and transmit it. */
  pushLocalCmd(cmd: TicCmd): void {
    const tic = this.sendTic++;
    this.cmds[this.slot]!.set(tic, cmd);
    const buf = new ArrayBuffer(5 + TICCMD_BYTES);
    const view = new DataView(buf);
    view.setUint8(0, MSG_CMD);
    view.setUint32(1, tic, true);
    encodeCmd(view, 5, cmd);
    this.ws?.send(buf);
  }

  /** Both cmds available for the next tic? */
  canAdvance(): boolean {
    return (
      this.cmds[0]!.has(this.simTic) &&
      this.cmds[1]!.has(this.simTic) &&
      this.desync === null
    );
  }

  /** Consecutive future tics for which both cmds are already buffered. */
  bufferedAhead(): number {
    let n = 0;
    while (this.cmds[0]!.has(this.simTic + n) && this.cmds[1]!.has(this.simTic + n)) n++;
    return n;
  }

  /** Run one lockstep tic. Returns the tic number just simulated.
   *  Cmds are retained — the full log is the game's serialization and
   *  powers replay-based desync recovery. */
  advance(sim: DoomSim): number {
    const tic = this.simTic;
    const c0 = this.cmds[0]!.get(tic) ?? emptyCmd();
    const c1 = this.cmds[1]!.get(tic) ?? emptyCmd();
    sim.runTic([c0, c1]);
    this.simTic++;

    // checksum exchange every 35 tics
    if (tic % 35 === 0) {
      const sum = simChecksum(sim);
      this.localChecksums.set(tic, sum);
      const buf = new ArrayBuffer(9);
      const view = new DataView(buf);
      view.setUint8(0, MSG_CHECKSUM);
      view.setUint32(1, tic, true);
      view.setUint32(5, sum, true);
      this.ws?.send(buf);
    }
    this.compareChecksums();
    return tic;
  }

  private compareChecksums(): void {
    for (const [tic, remote] of this.remoteChecksums) {
      const local = this.localChecksums.get(tic);
      if (local === undefined) continue;
      if (local !== remote) this.desync = tic;
      this.localChecksums.delete(tic);
      this.remoteChecksums.delete(tic);
    }
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

  /** Clear desync state after a successful replay resync. */
  clearDesync(): void {
    this.desync = null;
    this.localChecksums.clear();
    this.remoteChecksums.clear();
  }

  close(): void {
    this.ws?.close();
  }
}
