// Sector/line special effects and triggers, ported from p_spec.c: utility
// searches, P_CrossSpecialLine / P_ShootSpecialLine dispatch,
// P_PlayerInSpecialSector, P_UpdateSpecials and P_SpawnSpecials.
//
// Deliberately NOT ported: P_InitPicAnims and the flat/texture animation
// cycling in P_UpdateSpecials (renderer-side in DoomCraft) and the -TIMER
// levelTimer option.

import { MT } from '../data/info.gen.ts';
import { ML_TWOSIDED } from '../defs.ts';
import { FRACUNIT, MAXINT, type Fixed } from '../fixed.ts';
import type { DoomSim } from '../sim.ts';
import type { Line, Mobj, Player, Sector, Side } from '../world.ts';
import { CeilingType, EV_CeilingCrushStop, EV_DoCeiling, resetActiveCeilings } from './ceilings.ts';
import { DoorType, EV_DoDoor, P_SpawnDoorCloseIn30, P_SpawnDoorRaiseIn5Mins } from './doors.ts';
import { EV_BuildStairs, EV_DoFloor, FloorType, StairType } from './floors.ts';
import {
  EV_LightTurnOn, EV_StartLightStrobing, EV_TurnTagLightsOff,
  FASTDARK, SLOWDARK,
  P_SpawnFireFlicker, P_SpawnGlowingLight, P_SpawnLightFlash, P_SpawnStrobeFlash,
} from './lights.ts';
import { EV_DoPlat, EV_StopPlat, PlatType, resetActivePlats } from './plats.ts';
// (spec.ts <-> switches.ts import cycle is fine: all uses are at run time)
import { P_ChangeSwitchTexture, resetButtons, updateButtons } from './switches.ts';
import { EV_Teleport } from './teleport.ts';

const pw_ironfeet = 3;

//
// UTILITIES
//

//
// getSide()
// Will return a side_t*
//  given the number of the current sector,
//  the line number, and the side (0/1) that you want.
//
export function getSide(sim: DoomSim, currentSector: number, line: number, side: number): Side {
  return sim.world.sides[sim.world.sectors[currentSector]!.lines[line]!.sidenum[side]!]!;
}

//
// getSector()
// Will return a sector_t*
//  given the number of the current sector,
//  the line number and the side (0/1) that you want.
//
export function getSector(sim: DoomSim, currentSector: number, line: number, side: number): Sector {
  return getSide(sim, currentSector, line, side).sector;
}

//
// twoSided()
// Given the sector number and the line number,
//  it will tell you whether the line is two-sided or not.
//
export function twoSided(sim: DoomSim, sector: number, line: number): number {
  return sim.world.sectors[sector]!.lines[line]!.flags & ML_TWOSIDED;
}

//
// getNextSector()
// Return sector_t * of sector next to current.
// NULL if not two-sided line
//
export function getNextSector(line: Line, sec: Sector): Sector | null {
  if (!(line.flags & ML_TWOSIDED)) return null;

  if (line.frontsector === sec) return line.backsector;

  return line.frontsector;
}

//
// P_FindLowestFloorSurrounding()
// FIND LOWEST FLOOR HEIGHT IN SURROUNDING SECTORS
//
export function P_FindLowestFloorSurrounding(sec: Sector): Fixed {
  let floor = sec.floorheight;

  for (const check of sec.lines) {
    const other = getNextSector(check, sec);

    if (!other) continue;

    if (other.floorheight < floor) floor = other.floorheight;
  }
  return floor;
}

//
// P_FindHighestFloorSurrounding()
// FIND HIGHEST FLOOR HEIGHT IN SURROUNDING SECTORS
//
export function P_FindHighestFloorSurrounding(sec: Sector): Fixed {
  let floor = -500 * FRACUNIT;

  for (const check of sec.lines) {
    const other = getNextSector(check, sec);

    if (!other) continue;

    if (other.floorheight > floor) floor = other.floorheight;
  }
  return floor;
}

//
// P_FindNextHighestFloor
// FIND NEXT HIGHEST FLOOR IN SURROUNDING SECTORS
//
// Thanks to entryway for the Vanilla overflow emulation.
//

// 20 adjoining sectors max!
const MAX_ADJOINING_SECTORS = 20;

export function P_FindNextHighestFloor(sec: Sector, currentheight: Fixed): Fixed {
  let h = 0;
  let height = currentheight;
  const heightlist: Fixed[] = new Array<Fixed>(MAX_ADJOINING_SECTORS + 2).fill(0);

  for (const check of sec.lines) {
    const other = getNextSector(check, sec);

    if (!other) continue;

    if (other.floorheight > height) {
      // Emulation of memory (stack) overflow
      if (h === MAX_ADJOINING_SECTORS + 1) {
        height = other.floorheight;
      } else if (h === MAX_ADJOINING_SECTORS + 2) {
        // Fatal overflow: game crashes at 22 sectors
        throw new Error(
          'Sector with more than 22 adjoining sectors. Vanilla will crash here',
        );
      }

      heightlist[h++] = other.floorheight;
    }
  }

  // Find lowest height in list
  if (!h) return currentheight;

  let min = heightlist[0]!;

  // Range checking?
  for (let i = 1; i < h; i++) {
    if (heightlist[i]! < min) min = heightlist[i]!;
  }

  return min;
}

//
// FIND LOWEST CEILING IN THE SURROUNDING SECTORS
//
export function P_FindLowestCeilingSurrounding(sec: Sector): Fixed {
  let height = MAXINT;

  for (const check of sec.lines) {
    const other = getNextSector(check, sec);

    if (!other) continue;

    if (other.ceilingheight < height) height = other.ceilingheight;
  }
  return height;
}

//
// FIND HIGHEST CEILING IN THE SURROUNDING SECTORS
//
export function P_FindHighestCeilingSurrounding(sec: Sector): Fixed {
  let height = 0;

  for (const check of sec.lines) {
    const other = getNextSector(check, sec);

    if (!other) continue;

    if (other.ceilingheight > height) height = other.ceilingheight;
  }
  return height;
}

//
// RETURN NEXT SECTOR # THAT LINE TAG REFERS TO
//
export function P_FindSectorFromLineTag(sim: DoomSim, line: Line, start: number): number {
  const sectors = sim.world.sectors;
  for (let i = start + 1; i < sectors.length; i++) {
    if (sectors[i]!.tag === line.tag) return i;
  }
  return -1;
}

//
// Find minimum light from an adjacent sector
//
export function P_FindMinSurroundingLight(sector: Sector, max: number): number {
  let min = max;
  for (const line of sector.lines) {
    const check = getNextSector(line, sector);

    if (!check) continue;

    if (check.lightlevel < min) min = check.lightlevel;
  }
  return min;
}

//
// EVENTS
// Events are operations triggered by using, crossing,
// or shooting special lines, or by timed thinkers.
//

//
// P_CrossSpecialLine - TRIGGER
// Called every time a thing origin is about
//  to cross a line with a non 0 special.
//
export function P_CrossSpecialLine(sim: DoomSim, line: Line, side: number, thing: Mobj): void {
  // (gameversion > exe_doom_1_2)
  //	Triggers that other things can activate
  if (!thing.player) {
    // Things that should NOT trigger specials...
    switch (thing.type) {
      case MT.ROCKET:
      case MT.PLASMA:
      case MT.BFG:
      case MT.TROOPSHOT:
      case MT.HEADSHOT:
      case MT.BRUISERSHOT:
        return;

      default:
        break;
    }
  }

  if (!thing.player) {
    let ok = 0;
    switch (line.special) {
      case 39: // TELEPORT TRIGGER
      case 97: // TELEPORT RETRIGGER
      case 125: // TELEPORT MONSTERONLY TRIGGER
      case 126: // TELEPORT MONSTERONLY RETRIGGER
      case 4: // RAISE DOOR
      case 10: // PLAT DOWN-WAIT-UP-STAY TRIGGER
      case 88: // PLAT DOWN-WAIT-UP-STAY RETRIGGER
        ok = 1;
        break;
    }
    if (!ok) return;
  }

  // Note: could use some const's here.
  switch (line.special) {
    // TRIGGERS.
    // All from here to RETRIGGERS.
    case 2:
      // Open Door
      EV_DoDoor(sim, line, DoorType.Open);
      line.special = 0;
      break;

    case 3:
      // Close Door
      EV_DoDoor(sim, line, DoorType.Close);
      line.special = 0;
      break;

    case 4:
      // Raise Door
      EV_DoDoor(sim, line, DoorType.Normal);
      line.special = 0;
      break;

    case 5:
      // Raise Floor
      EV_DoFloor(sim, line, FloorType.RaiseFloor);
      line.special = 0;
      break;

    case 6:
      // Fast Ceiling Crush & Raise
      EV_DoCeiling(sim, line, CeilingType.FastCrushAndRaise);
      line.special = 0;
      break;

    case 8:
      // Build Stairs
      EV_BuildStairs(sim, line, StairType.Build8);
      line.special = 0;
      break;

    case 10:
      // PlatDownWaitUp
      EV_DoPlat(sim, line, PlatType.DownWaitUpStay, 0);
      line.special = 0;
      break;

    case 12:
      // Light Turn On - brightest near
      EV_LightTurnOn(sim, line, 0);
      line.special = 0;
      break;

    case 13:
      // Light Turn On 255
      EV_LightTurnOn(sim, line, 255);
      line.special = 0;
      break;

    case 16:
      // Close Door 30
      EV_DoDoor(sim, line, DoorType.Close30ThenOpen);
      line.special = 0;
      break;

    case 17:
      // Start Light Strobing
      EV_StartLightStrobing(sim, line);
      line.special = 0;
      break;

    case 19:
      // Lower Floor
      EV_DoFloor(sim, line, FloorType.LowerFloor);
      line.special = 0;
      break;

    case 22:
      // Raise floor to nearest height and change texture
      EV_DoPlat(sim, line, PlatType.RaiseToNearestAndChange, 0);
      line.special = 0;
      break;

    case 25:
      // Ceiling Crush and Raise
      EV_DoCeiling(sim, line, CeilingType.CrushAndRaise);
      line.special = 0;
      break;

    case 30:
      // Raise floor to shortest texture height
      //  on either side of lines.
      EV_DoFloor(sim, line, FloorType.RaiseToTexture);
      line.special = 0;
      break;

    case 35:
      // Lights Very Dark
      EV_LightTurnOn(sim, line, 35);
      line.special = 0;
      break;

    case 36:
      // Lower Floor (TURBO)
      EV_DoFloor(sim, line, FloorType.TurboLower);
      line.special = 0;
      break;

    case 37:
      // LowerAndChange
      EV_DoFloor(sim, line, FloorType.LowerAndChange);
      line.special = 0;
      break;

    case 38:
      // Lower Floor To Lowest
      EV_DoFloor(sim, line, FloorType.LowerFloorToLowest);
      line.special = 0;
      break;

    case 39:
      // TELEPORT!
      EV_Teleport(sim, line, side, thing);
      line.special = 0;
      break;

    case 40:
      // RaiseCeilingLowerFloor
      EV_DoCeiling(sim, line, CeilingType.RaiseToHighest);
      EV_DoFloor(sim, line, FloorType.LowerFloorToLowest);
      line.special = 0;
      break;

    case 44:
      // Ceiling Crush
      EV_DoCeiling(sim, line, CeilingType.LowerAndCrush);
      line.special = 0;
      break;

    case 52:
      // EXIT!
      sim.exitLevel(false);
      break;

    case 53:
      // Perpetual Platform Raise
      EV_DoPlat(sim, line, PlatType.PerpetualRaise, 0);
      line.special = 0;
      break;

    case 54:
      // Platform Stop
      EV_StopPlat(line);
      line.special = 0;
      break;

    case 56:
      // Raise Floor Crush
      EV_DoFloor(sim, line, FloorType.RaiseFloorCrush);
      line.special = 0;
      break;

    case 57:
      // Ceiling Crush Stop
      EV_CeilingCrushStop(line);
      line.special = 0;
      break;

    case 58:
      // Raise Floor 24
      EV_DoFloor(sim, line, FloorType.RaiseFloor24);
      line.special = 0;
      break;

    case 59:
      // Raise Floor 24 And Change
      EV_DoFloor(sim, line, FloorType.RaiseFloor24AndChange);
      line.special = 0;
      break;

    case 104:
      // Turn lights off in sector(tag)
      EV_TurnTagLightsOff(sim, line);
      line.special = 0;
      break;

    case 108:
      // Blazing Door Raise (faster than TURBO!)
      EV_DoDoor(sim, line, DoorType.BlazeRaise);
      line.special = 0;
      break;

    case 109:
      // Blazing Door Open (faster than TURBO!)
      EV_DoDoor(sim, line, DoorType.BlazeOpen);
      line.special = 0;
      break;

    case 100:
      // Build Stairs Turbo 16
      EV_BuildStairs(sim, line, StairType.Turbo16);
      line.special = 0;
      break;

    case 110:
      // Blazing Door Close (faster than TURBO!)
      EV_DoDoor(sim, line, DoorType.BlazeClose);
      line.special = 0;
      break;

    case 119:
      // Raise floor to nearest surr. floor
      EV_DoFloor(sim, line, FloorType.RaiseFloorToNearest);
      line.special = 0;
      break;

    case 121:
      // Blazing PlatDownWaitUpStay
      EV_DoPlat(sim, line, PlatType.BlazeDWUS, 0);
      line.special = 0;
      break;

    case 124:
      // Secret EXIT
      sim.exitLevel(true);
      break;

    case 125:
      // TELEPORT MonsterONLY
      if (!thing.player) {
        EV_Teleport(sim, line, side, thing);
        line.special = 0;
      }
      break;

    case 130:
      // Raise Floor Turbo
      EV_DoFloor(sim, line, FloorType.RaiseFloorTurbo);
      line.special = 0;
      break;

    case 141:
      // Silent Ceiling Crush & Raise
      EV_DoCeiling(sim, line, CeilingType.SilentCrushAndRaise);
      line.special = 0;
      break;

    // RETRIGGERS.  All from here till end.
    case 72:
      // Ceiling Crush
      EV_DoCeiling(sim, line, CeilingType.LowerAndCrush);
      break;

    case 73:
      // Ceiling Crush and Raise
      EV_DoCeiling(sim, line, CeilingType.CrushAndRaise);
      break;

    case 74:
      // Ceiling Crush Stop
      EV_CeilingCrushStop(line);
      break;

    case 75:
      // Close Door
      EV_DoDoor(sim, line, DoorType.Close);
      break;

    case 76:
      // Close Door 30
      EV_DoDoor(sim, line, DoorType.Close30ThenOpen);
      break;

    case 77:
      // Fast Ceiling Crush & Raise
      EV_DoCeiling(sim, line, CeilingType.FastCrushAndRaise);
      break;

    case 79:
      // Lights Very Dark
      EV_LightTurnOn(sim, line, 35);
      break;

    case 80:
      // Light Turn On - brightest near
      EV_LightTurnOn(sim, line, 0);
      break;

    case 81:
      // Light Turn On 255
      EV_LightTurnOn(sim, line, 255);
      break;

    case 82:
      // Lower Floor To Lowest
      EV_DoFloor(sim, line, FloorType.LowerFloorToLowest);
      break;

    case 83:
      // Lower Floor
      EV_DoFloor(sim, line, FloorType.LowerFloor);
      break;

    case 84:
      // LowerAndChange
      EV_DoFloor(sim, line, FloorType.LowerAndChange);
      break;

    case 86:
      // Open Door
      EV_DoDoor(sim, line, DoorType.Open);
      break;

    case 87:
      // Perpetual Platform Raise
      EV_DoPlat(sim, line, PlatType.PerpetualRaise, 0);
      break;

    case 88:
      // PlatDownWaitUp
      EV_DoPlat(sim, line, PlatType.DownWaitUpStay, 0);
      break;

    case 89:
      // Platform Stop
      EV_StopPlat(line);
      break;

    case 90:
      // Raise Door
      EV_DoDoor(sim, line, DoorType.Normal);
      break;

    case 91:
      // Raise Floor
      EV_DoFloor(sim, line, FloorType.RaiseFloor);
      break;

    case 92:
      // Raise Floor 24
      EV_DoFloor(sim, line, FloorType.RaiseFloor24);
      break;

    case 93:
      // Raise Floor 24 And Change
      EV_DoFloor(sim, line, FloorType.RaiseFloor24AndChange);
      break;

    case 94:
      // Raise Floor Crush
      EV_DoFloor(sim, line, FloorType.RaiseFloorCrush);
      break;

    case 95:
      // Raise floor to nearest height
      // and change texture.
      EV_DoPlat(sim, line, PlatType.RaiseToNearestAndChange, 0);
      break;

    case 96:
      // Raise floor to shortest texture height
      // on either side of lines.
      EV_DoFloor(sim, line, FloorType.RaiseToTexture);
      break;

    case 97:
      // TELEPORT!
      EV_Teleport(sim, line, side, thing);
      break;

    case 98:
      // Lower Floor (TURBO)
      EV_DoFloor(sim, line, FloorType.TurboLower);
      break;

    case 105:
      // Blazing Door Raise (faster than TURBO!)
      EV_DoDoor(sim, line, DoorType.BlazeRaise);
      break;

    case 106:
      // Blazing Door Open (faster than TURBO!)
      EV_DoDoor(sim, line, DoorType.BlazeOpen);
      break;

    case 107:
      // Blazing Door Close (faster than TURBO!)
      EV_DoDoor(sim, line, DoorType.BlazeClose);
      break;

    case 120:
      // Blazing PlatDownWaitUpStay.
      EV_DoPlat(sim, line, PlatType.BlazeDWUS, 0);
      break;

    case 126:
      // TELEPORT MonsterONLY.
      if (!thing.player) EV_Teleport(sim, line, side, thing);
      break;

    case 128:
      // Raise To Nearest Floor
      EV_DoFloor(sim, line, FloorType.RaiseFloorToNearest);
      break;

    case 129:
      // Raise Floor Turbo
      EV_DoFloor(sim, line, FloorType.RaiseFloorTurbo);
      break;
  }
}

//
// P_ShootSpecialLine - IMPACT SPECIALS
// Called when a thing shoots a special line.
//
export function P_ShootSpecialLine(sim: DoomSim, thing: Mobj, line: Line): void {
  //	Impacts that other things can activate.
  if (!thing.player) {
    let ok = 0;
    switch (line.special) {
      case 46:
        // OPEN DOOR IMPACT
        ok = 1;
        break;
    }
    if (!ok) return;
  }

  switch (line.special) {
    case 24:
      // RAISE FLOOR
      EV_DoFloor(sim, line, FloorType.RaiseFloor);
      P_ChangeSwitchTexture(sim, line, 0);
      break;

    case 46:
      // OPEN DOOR
      EV_DoDoor(sim, line, DoorType.Open);
      P_ChangeSwitchTexture(sim, line, 1);
      break;

    case 47:
      // RAISE FLOOR NEAR AND CHANGE
      EV_DoPlat(sim, line, PlatType.RaiseToNearestAndChange, 0);
      P_ChangeSwitchTexture(sim, line, 0);
      break;
  }
}

//
// P_PlayerInSpecialSector
// Called every tic frame
//  that the player origin is in a special sector
//
export function P_PlayerInSpecialSector(sim: DoomSim, player: Player): void {
  const sector = player.mo!.subsector!.sector;

  // Falling, not all the way down yet?
  if (player.mo!.z !== sector.floorheight) return;

  // Has hitten ground.
  switch (sector.special) {
    case 5:
      // HELLSLIME DAMAGE
      if (!player.powers[pw_ironfeet]) {
        if (!(sim.leveltime & 0x1f)) sim.damageMobj(player.mo!, null, null, 10);
      }
      break;

    case 7:
      // NUKAGE DAMAGE
      if (!player.powers[pw_ironfeet]) {
        if (!(sim.leveltime & 0x1f)) sim.damageMobj(player.mo!, null, null, 5);
      }
      break;

    case 16:
    // SUPER HELLSLIME DAMAGE
    case 4:
      // STROBE HURT
      if (!player.powers[pw_ironfeet] || sim.rng.pRandom() < 5) {
        if (!(sim.leveltime & 0x1f)) sim.damageMobj(player.mo!, null, null, 20);
      }
      break;

    case 9:
      // SECRET SECTOR
      player.secretcount++;
      sector.special = 0;
      break;

    case 11:
      // EXIT SUPER DAMAGE! (for E1M8 finale)
      // (player->cheats &= ~CF_GODMODE dropped: no cheats in DoomCraft)
      if (!(sim.leveltime & 0x1f)) sim.damageMobj(player.mo!, null, null, 20);

      if (player.health <= 10) sim.exitLevel(false);
      break;

    default:
      throw new Error(`P_PlayerInSpecialSector: unknown special ${sector.special}`);
  }
}

//
// P_UpdateSpecials
// Animate planes, scroll walls, etc.
//
// (the -TIMER levelTimer and the global flat/texture animation cycling
// are not ported; texture/flat cycling is renderer-side in DoomCraft)
//

//      Animating line specials
const MAXLINEANIMS = 64;

let linespeciallist: Line[] = [];

export function P_UpdateSpecials(sim: DoomSim): void {
  //	ANIMATE LINE SPECIALS
  for (const line of linespeciallist) {
    switch (line.special) {
      case 48:
        // EFFECT FIRSTCOL SCROLL +
        {
          const side = sim.world.sides[line.sidenum[0]]!;
          side.textureoffset = (side.textureoffset + FRACUNIT) | 0;
        }
        break;
    }
  }

  //	DO BUTTONS
  updateButtons(sim);
}

//
// SPECIAL SPAWNING
//

//
// P_SpawnSpecials
// After the map has been loaded, scan for specials
//  that spawn thinkers
//
export function P_SpawnSpecials(sim: DoomSim): void {
  const w = sim.world;

  // (no -TIMER option: levelTimer not ported)

  //	Init special SECTORs.
  for (const sector of w.sectors) {
    if (!sector.special) continue;

    switch (sector.special) {
      case 1:
        // FLICKERING LIGHTS
        P_SpawnLightFlash(sim, sector);
        break;

      case 2:
        // STROBE FAST
        P_SpawnStrobeFlash(sim, sector, FASTDARK, 0);
        break;

      case 3:
        // STROBE SLOW
        P_SpawnStrobeFlash(sim, sector, SLOWDARK, 0);
        break;

      case 4:
        // STROBE FAST/DEATH SLIME
        P_SpawnStrobeFlash(sim, sector, FASTDARK, 0);
        sector.special = 4;
        break;

      case 8:
        // GLOWING LIGHT
        P_SpawnGlowingLight(sim, sector);
        break;

      case 9:
        // SECRET SECTOR
        // (totalsecret tally dropped: no intermission stats in DoomCraft;
        // found secrets count on player.secretcount)
        break;

      case 10:
        // DOOR CLOSE IN 30 SECONDS
        P_SpawnDoorCloseIn30(sim, sector);
        break;

      case 12:
        // SYNC STROBE SLOW
        P_SpawnStrobeFlash(sim, sector, SLOWDARK, 1);
        break;

      case 13:
        // SYNC STROBE FAST
        P_SpawnStrobeFlash(sim, sector, FASTDARK, 1);
        break;

      case 14:
        // DOOR RAISE IN 5 MINUTES
        P_SpawnDoorRaiseIn5Mins(sim, sector, sector.index);
        break;

      case 17:
        // FIRELIGHT FLICKER (first introduced in official v1.4 beta)
        P_SpawnFireFlicker(sim, sector);
        break;
    }
  }

  //	Init line EFFECTs
  linespeciallist = [];
  for (const line of w.lines) {
    switch (line.special) {
      case 48:
        if (linespeciallist.length >= MAXLINEANIMS) {
          throw new Error(
            `P_SpawnSpecials: Too many scrolling wall linedefs! (Vanilla limit is ${MAXLINEANIMS})`,
          );
        }
        // EFFECT FIRSTCOL SCROLL+
        linespeciallist.push(line);
        break;
    }
  }

  //	Init other misc stuff
  resetActiveCeilings();
  resetActivePlats();
  resetButtons();
}
