// Per-tic player input — the only thing exchanged over the network.
// 10 bytes on the wire (see SPEC.md §5).

export interface TicCmd {
  /** -0x32..0x32 (run) */
  forwardmove: number;
  sidemove: number;
  /** added to angle << 16 (vanilla semantics) */
  angleturn: number;
  /** DoomCraft freelook: added to pitch << 16, clamped in P_PlayerThink */
  pitch: number;
  buttons: number;
  buttons2: number;
}

export function emptyCmd(): TicCmd {
  return { forwardmove: 0, sidemove: 0, angleturn: 0, pitch: 0, buttons: 0, buttons2: 0 };
}

export function copyCmd(dst: TicCmd, src: TicCmd): void {
  dst.forwardmove = src.forwardmove;
  dst.sidemove = src.sidemove;
  dst.angleturn = src.angleturn;
  dst.pitch = src.pitch;
  dst.buttons = src.buttons;
  dst.buttons2 = src.buttons2;
}

export function encodeCmd(view: DataView, offset: number, cmd: TicCmd): void {
  view.setInt8(offset, cmd.forwardmove);
  view.setInt8(offset + 1, cmd.sidemove);
  view.setInt16(offset + 2, cmd.angleturn, true);
  view.setInt16(offset + 4, cmd.pitch, true);
  view.setUint8(offset + 6, cmd.buttons);
  view.setUint8(offset + 7, cmd.buttons2);
  view.setUint16(offset + 8, 0, true); // pad/reserved
}

export function decodeCmd(view: DataView, offset: number): TicCmd {
  return {
    forwardmove: view.getInt8(offset),
    sidemove: view.getInt8(offset + 1),
    angleturn: view.getInt16(offset + 2, true),
    pitch: view.getInt16(offset + 4, true),
    buttons: view.getUint8(offset + 6),
    buttons2: view.getUint8(offset + 7),
  };
}

export const TICCMD_BYTES = 10;
