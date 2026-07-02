// Lockstep netplay client. Delay-based deterministic lockstep at 35Hz:
// each side sends only its ticcmds (10 bytes + header); the sim advances
// when both players' cmds for the next tic are buffered. FNV checksums
// exchanged every 35 tics detect desync.

import { simChecksum } from '../sim/checksum.ts';
import type { DoomSim } from '../sim/sim.ts';
import { decodeCmd, emptyCmd, encodeCmd, TICCMD_BYTES, type TicCmd } from '../sim/ticcmd.ts';

const MSG_CMD = 1;
const MSG_CHECKSUM = 2;

export const INPUT_DELAY = 3; // tics (~86ms)

export interface LobbyResult {
  slot: number;
  map: number;
  skill: number;
  room: string;
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

  /** Connect and run the lobby: create a room or join one. */
  connect(url: string, opts: { room?: string; map?: number; wadHash: string }): Promise<LobbyResult> {
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
          resolve({ slot: msg.slot, map: msg.map, skill: msg.skill, room: this.room });
        } else if (msg.t === 'error') {
          reject(new Error(msg.reason));
        } else if (msg.t === 'peerleft') {
          this.peerLeft = true;
        }
      };
    });
  }

  private onBinary(view: DataView): void {
    const type = view.getUint8(0);
    const tic = view.getUint32(1, true);
    if (type === MSG_CMD) {
      this.cmds[this.slot ^ 1]!.set(tic, decodeCmd(view, 5));
    } else if (type === MSG_CHECKSUM) {
      this.remoteChecksums.set(tic, view.getUint32(5, true));
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

  /** Run one lockstep tic. Returns the tic number just simulated. */
  advance(sim: DoomSim): number {
    const tic = this.simTic;
    const c0 = this.cmds[0]!.get(tic) ?? emptyCmd();
    const c1 = this.cmds[1]!.get(tic) ?? emptyCmd();
    sim.runTic([c0, c1]);
    this.cmds[0]!.delete(tic);
    this.cmds[1]!.delete(tic);
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

  close(): void {
    this.ws?.close();
  }
}
