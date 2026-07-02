// Switches, buttons. Two-state animation. Exits. Ported from p_switch.c.
// Switch pairs swap by texture NAME (DoomCraft sides store names).

import { SFX } from '../data/sounds.gen.ts';
import { ML_SECRET } from '../defs.ts';
import type { DoomSim } from '../sim.ts';
import type { Line, Mobj, Sector } from '../world.ts';
import { CeilingType, EV_DoCeiling } from './ceilings.ts';
import { DoorType, EV_DoDoor, EV_DoLockedDoor, EV_VerticalDoor } from './doors.ts';
import { EV_BuildStairs, EV_DoDonut, EV_DoFloor, FloorType, StairType } from './floors.ts';
import { EV_LightTurnOn } from './lights.ts';
import { EV_DoPlat, PlatType } from './plats.ts';

const alphSwitchList: readonly (readonly [string, string, number])[] = [
  // Doom shareware episode 1 switches
  ['SW1BRCOM', 'SW2BRCOM', 1],
  ['SW1BRN1', 'SW2BRN1', 1],
  ['SW1BRN2', 'SW2BRN2', 1],
  ['SW1BRNGN', 'SW2BRNGN', 1],
  ['SW1BROWN', 'SW2BROWN', 1],
  ['SW1COMM', 'SW2COMM', 1],
  ['SW1COMP', 'SW2COMP', 1],
  ['SW1DIRT', 'SW2DIRT', 1],
  ['SW1EXIT', 'SW2EXIT', 1],
  ['SW1GRAY', 'SW2GRAY', 1],
  ['SW1GRAY1', 'SW2GRAY1', 1],
  ['SW1METAL', 'SW2METAL', 1],
  ['SW1PIPE', 'SW2PIPE', 1],
  ['SW1SLAD', 'SW2SLAD', 1],
  ['SW1STARG', 'SW2STARG', 1],
  ['SW1STON1', 'SW2STON1', 1],
  ['SW1STON2', 'SW2STON2', 1],
  ['SW1STONE', 'SW2STONE', 1],
  ['SW1STRTN', 'SW2STRTN', 1],

  // Doom registered episodes 2&3 switches
  ['SW1BLUE', 'SW2BLUE', 2],
  ['SW1CMT', 'SW2CMT', 2],
  ['SW1GARG', 'SW2GARG', 2],
  ['SW1GSTON', 'SW2GSTON', 2],
  ['SW1HOT', 'SW2HOT', 2],
  ['SW1LION', 'SW2LION', 2],
  ['SW1SATYR', 'SW2SATYR', 2],
  ['SW1SKIN', 'SW2SKIN', 2],
  ['SW1VINE', 'SW2VINE', 2],
  ['SW1WOOD', 'SW2WOOD', 2],

  // Doom II switches
  ['SW1PANEL', 'SW2PANEL', 3],
  ['SW1ROCK', 'SW2ROCK', 3],
  ['SW1MET2', 'SW2MET2', 3],
  ['SW1WDMET', 'SW2WDMET', 3],
  ['SW1BRIK', 'SW2BRIK', 3],
  ['SW1MOD1', 'SW2MOD1', 3],
  ['SW1ZIM', 'SW2ZIM', 3],
  ['SW1STON6', 'SW2STON6', 3],
  ['SW1TEK', 'SW2TEK', 3],
  ['SW1MARB', 'SW2MARB', 3],
  ['SW1SKULL', 'SW2SKULL', 3],
];

// max # of wall switches in a level
export const MAXSWITCHES = 50;
// 4 players, 4 buttons each at once, max.
export const MAXBUTTONS = 16;
// 1 second, in ticks.
export const BUTTONTIME = 35;

const enum BWhere {
  Top,
  Middle,
  Bottom,
}

class Button {
  line: Line | null = null;
  where: BWhere = BWhere.Top;
  btexture = '';
  btimer = 0;
  soundorg: Sector | null = null;

  clear(): void {
    this.line = null;
    this.where = BWhere.Top;
    this.btexture = '';
    this.btimer = 0;
    this.soundorg = null;
  }
}

const buttonlist: Button[] = Array.from({ length: MAXBUTTONS }, () => new Button());

/** Clear all button slots (level start). */
export function resetButtons(): void {
  for (const b of buttonlist) b.clear();
}

const switchlist: string[] = [];
let numswitches = 0;

//
// P_InitSwitchList
// Only called at game initialization.
//
export function P_InitSwitchList(): void {
  // DoomCraft is Doom 2 (commercial): all entries up to "episode" 3.
  const episode = 3;

  let slindex = 0;
  switchlist.length = 0;
  for (const [name1, name2, ep] of alphSwitchList) {
    if (ep <= episode) {
      switchlist[slindex++] = name1;
      switchlist[slindex++] = name2;
    }
  }

  numswitches = (slindex / 2) | 0;
}

//
// Start a button counting down till it turns off.
//
function P_StartButton(line: Line, w: BWhere, texture: string, time: number): void {
  // See if button is already pressed
  for (let i = 0; i < MAXBUTTONS; i++) {
    if (buttonlist[i]!.btimer && buttonlist[i]!.line === line) return;
  }

  for (let i = 0; i < MAXBUTTONS; i++) {
    const b = buttonlist[i]!;
    if (!b.btimer) {
      b.line = line;
      b.where = w;
      b.btexture = texture;
      b.btimer = time;
      b.soundorg = line.frontsector;
      return;
    }
  }

  throw new Error('P_StartButton: no button slots left!');
}

// Vanilla bug kept: switch sounds play from buttonlist[0]'s soundorg,
// not the switch's own sector (a global sound when slot 0 is empty).
function startButtonSound(sim: DoomSim, sound: number): void {
  const so = buttonlist[0]!.soundorg;
  if (so) sim.startSectorSound(so, sound);
  else sim.startSoundNum(null, sound);
}

//
// Function that changes wall texture.
// Tell it if switch is ok to use again (1=yes, it's a button).
//
export function P_ChangeSwitchTexture(sim: DoomSim, line: Line, useAgain: number): void {
  if (!useAgain) line.special = 0;

  const side = sim.world.sides[line.sidenum[0]]!;
  const texTop = side.toptexture;
  const texMid = side.midtexture;
  const texBot = side.bottomtexture;

  let sound: number = SFX.swtchn;

  // EXIT SWITCH?
  if (line.special === 11) sound = SFX.swtchx;

  for (let i = 0; i < numswitches * 2; i++) {
    if (switchlist[i] === texTop) {
      startButtonSound(sim, sound);
      side.toptexture = switchlist[i ^ 1]!;

      if (useAgain) P_StartButton(line, BWhere.Top, switchlist[i]!, BUTTONTIME);

      return;
    } else {
      if (switchlist[i] === texMid) {
        startButtonSound(sim, sound);
        side.midtexture = switchlist[i ^ 1]!;

        if (useAgain) P_StartButton(line, BWhere.Middle, switchlist[i]!, BUTTONTIME);

        return;
      } else {
        if (switchlist[i] === texBot) {
          startButtonSound(sim, sound);
          side.bottomtexture = switchlist[i ^ 1]!;

          if (useAgain) P_StartButton(line, BWhere.Bottom, switchlist[i]!, BUTTONTIME);

          return;
        }
      }
    }
  }
}

/** The "DO BUTTONS" part of P_UpdateSpecials: restore pressed switches. */
export function updateButtons(sim: DoomSim): void {
  for (let i = 0; i < MAXBUTTONS; i++) {
    const b = buttonlist[i]!;
    if (b.btimer) {
      b.btimer--;
      if (!b.btimer) {
        const side = sim.world.sides[b.line!.sidenum[0]]!;
        switch (b.where) {
          case BWhere.Top:
            side.toptexture = b.btexture;
            break;

          case BWhere.Middle:
            side.midtexture = b.btexture;
            break;

          case BWhere.Bottom:
            side.bottomtexture = b.btexture;
            break;
        }
        sim.startSectorSound(b.soundorg!, SFX.swtchn);
        b.clear();
      }
    }
  }
}

//
// P_UseSpecialLine
// Called when a thing uses a special line.
// Only the front sides of lines are usable.
//
export function P_UseSpecialLine(sim: DoomSim, thing: Mobj, line: Line, side: number): boolean {
  // Err...
  // Use the back sides of VERY SPECIAL lines...
  if (side) {
    switch (line.special) {
      case 124:
        // Sliding door open&close
        // UNUSED?
        break;

      default:
        return false;
    }
  }

  // Switches that other things can activate.
  if (!thing.player) {
    // never open secret doors
    if (line.flags & ML_SECRET) return false;

    switch (line.special) {
      case 1: // MANUAL DOOR RAISE
      case 32: // MANUAL BLUE
      case 33: // MANUAL RED
      case 34: // MANUAL YELLOW
        break;

      default:
        return false;
    }
  }

  // do something
  switch (line.special) {
    // MANUALS
    case 1: // Vertical Door
    case 26: // Blue Door/Locked
    case 27: // Yellow Door /Locked
    case 28: // Red Door /Locked

    case 31: // Manual door open
    case 32: // Blue locked door open
    case 33: // Red locked door open
    case 34: // Yellow locked door open

    case 117: // Blazing door raise
    case 118: // Blazing door open
      EV_VerticalDoor(sim, line, thing);
      break;

    // UNUSED - Door Slide Open&Close
    // case 124:

    // SWITCHES
    case 7:
      // Build Stairs
      if (EV_BuildStairs(sim, line, StairType.Build8)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 9:
      // Change Donut
      if (EV_DoDonut(sim, line)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 11:
      // Exit level
      P_ChangeSwitchTexture(sim, line, 0);
      sim.exitLevel(false);
      break;

    case 14:
      // Raise Floor 32 and change texture
      if (EV_DoPlat(sim, line, PlatType.RaiseAndChange, 32)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 15:
      // Raise Floor 24 and change texture
      if (EV_DoPlat(sim, line, PlatType.RaiseAndChange, 24)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 18:
      // Raise Floor to next highest floor
      if (EV_DoFloor(sim, line, FloorType.RaiseFloorToNearest)) {
        P_ChangeSwitchTexture(sim, line, 0);
      }
      break;

    case 20:
      // Raise Plat next highest floor and change texture
      if (EV_DoPlat(sim, line, PlatType.RaiseToNearestAndChange, 0)) {
        P_ChangeSwitchTexture(sim, line, 0);
      }
      break;

    case 21:
      // PlatDownWaitUpStay
      if (EV_DoPlat(sim, line, PlatType.DownWaitUpStay, 0)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 23:
      // Lower Floor to Lowest
      if (EV_DoFloor(sim, line, FloorType.LowerFloorToLowest)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 29:
      // Raise Door
      if (EV_DoDoor(sim, line, DoorType.Normal)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 41:
      // Lower Ceiling to Floor
      if (EV_DoCeiling(sim, line, CeilingType.LowerToFloor)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 71:
      // Turbo Lower Floor
      if (EV_DoFloor(sim, line, FloorType.TurboLower)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 49:
      // Ceiling Crush And Raise
      if (EV_DoCeiling(sim, line, CeilingType.CrushAndRaise)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 50:
      // Close Door
      if (EV_DoDoor(sim, line, DoorType.Close)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 51:
      // Secret EXIT
      P_ChangeSwitchTexture(sim, line, 0);
      sim.exitLevel(true);
      break;

    case 55:
      // Raise Floor Crush
      if (EV_DoFloor(sim, line, FloorType.RaiseFloorCrush)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 101:
      // Raise Floor
      if (EV_DoFloor(sim, line, FloorType.RaiseFloor)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 102:
      // Lower Floor to Surrounding floor height
      if (EV_DoFloor(sim, line, FloorType.LowerFloor)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 103:
      // Open Door
      if (EV_DoDoor(sim, line, DoorType.Open)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 111:
      // Blazing Door Raise (faster than TURBO!)
      if (EV_DoDoor(sim, line, DoorType.BlazeRaise)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 112:
      // Blazing Door Open (faster than TURBO!)
      if (EV_DoDoor(sim, line, DoorType.BlazeOpen)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 113:
      // Blazing Door Close (faster than TURBO!)
      if (EV_DoDoor(sim, line, DoorType.BlazeClose)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 122:
      // Blazing PlatDownWaitUpStay
      if (EV_DoPlat(sim, line, PlatType.BlazeDWUS, 0)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 127:
      // Build Stairs Turbo 16
      if (EV_BuildStairs(sim, line, StairType.Turbo16)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 131:
      // Raise Floor Turbo
      if (EV_DoFloor(sim, line, FloorType.RaiseFloorTurbo)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 133:
    // BlzOpenDoor BLUE
    case 135:
    // BlzOpenDoor RED
    case 137:
      // BlzOpenDoor YELLOW
      if (EV_DoLockedDoor(sim, line, DoorType.BlazeOpen, thing)) {
        P_ChangeSwitchTexture(sim, line, 0);
      }
      break;

    case 140:
      // Raise Floor 512
      if (EV_DoFloor(sim, line, FloorType.RaiseFloor512)) P_ChangeSwitchTexture(sim, line, 0);
      break;

    // BUTTONS
    case 42:
      // Close Door
      if (EV_DoDoor(sim, line, DoorType.Close)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 43:
      // Lower Ceiling to Floor
      if (EV_DoCeiling(sim, line, CeilingType.LowerToFloor)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 45:
      // Lower Floor to Surrounding floor height
      if (EV_DoFloor(sim, line, FloorType.LowerFloor)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 60:
      // Lower Floor to Lowest
      if (EV_DoFloor(sim, line, FloorType.LowerFloorToLowest)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 61:
      // Open Door
      if (EV_DoDoor(sim, line, DoorType.Open)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 62:
      // PlatDownWaitUpStay
      if (EV_DoPlat(sim, line, PlatType.DownWaitUpStay, 1)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 63:
      // Raise Door
      if (EV_DoDoor(sim, line, DoorType.Normal)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 64:
      // Raise Floor to ceiling
      if (EV_DoFloor(sim, line, FloorType.RaiseFloor)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 66:
      // Raise Floor 24 and change texture
      if (EV_DoPlat(sim, line, PlatType.RaiseAndChange, 24)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 67:
      // Raise Floor 32 and change texture
      if (EV_DoPlat(sim, line, PlatType.RaiseAndChange, 32)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 65:
      // Raise Floor Crush
      if (EV_DoFloor(sim, line, FloorType.RaiseFloorCrush)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 68:
      // Raise Plat to next highest floor and change texture
      if (EV_DoPlat(sim, line, PlatType.RaiseToNearestAndChange, 0)) {
        P_ChangeSwitchTexture(sim, line, 1);
      }
      break;

    case 69:
      // Raise Floor to next highest floor
      if (EV_DoFloor(sim, line, FloorType.RaiseFloorToNearest)) {
        P_ChangeSwitchTexture(sim, line, 1);
      }
      break;

    case 70:
      // Turbo Lower Floor
      if (EV_DoFloor(sim, line, FloorType.TurboLower)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 114:
      // Blazing Door Raise (faster than TURBO!)
      if (EV_DoDoor(sim, line, DoorType.BlazeRaise)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 115:
      // Blazing Door Open (faster than TURBO!)
      if (EV_DoDoor(sim, line, DoorType.BlazeOpen)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 116:
      // Blazing Door Close (faster than TURBO!)
      if (EV_DoDoor(sim, line, DoorType.BlazeClose)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 123:
      // Blazing PlatDownWaitUpStay
      if (EV_DoPlat(sim, line, PlatType.BlazeDWUS, 0)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 132:
      // Raise Floor Turbo
      if (EV_DoFloor(sim, line, FloorType.RaiseFloorTurbo)) P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 99:
    // BlzOpenDoor BLUE
    case 134:
    // BlzOpenDoor RED
    case 136:
      // BlzOpenDoor YELLOW
      if (EV_DoLockedDoor(sim, line, DoorType.BlazeOpen, thing)) {
        P_ChangeSwitchTexture(sim, line, 1);
      }
      break;

    case 138:
      // Light Turn On
      EV_LightTurnOn(sim, line, 255);
      P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 139:
      // Light Turn Off
      EV_LightTurnOn(sim, line, 35);
      P_ChangeSwitchTexture(sim, line, 1);
      break;
  }

  return true;
}
