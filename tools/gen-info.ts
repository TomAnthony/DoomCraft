// One-off codegen: transpile Chocolate Doom's gameplay definition tables
// (info.c states/mobjinfo/sprnames, sounds.c, and the relevant enums) into
// TypeScript. Hand-porting ~1,100 table rows would guarantee typo-desyncs;
// generating them eliminates that bug class.
//
// Usage: node --experimental-strip-types tools/gen-info.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doomSrc = join(root, 'reference', 'chocolate-doom', 'src', 'doom');

const infoH = readFileSync(join(doomSrc, 'info.h'), 'utf8');
const infoC = readFileSync(join(doomSrc, 'info.c'), 'utf8');
const soundsH = readFileSync(join(doomSrc, 'sounds.h'), 'utf8');
const soundsC = readFileSync(join(doomSrc, 'sounds.c'), 'utf8');
const pMobjH = readFileSync(join(doomSrc, 'p_mobj.h'), 'utf8');

function stripComments(c: string): string {
  return c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Parses a C enum body into name → value, honoring `= value` overrides.
function parseEnum(source: string, typedefName: string): Map<string, number> {
  // Body must be brace-free ([^}]*) so the match can't start at an
  // earlier enum and swallow everything up to this typedef's name.
  const re = new RegExp(String.raw`typedef\s+enum\s*\{([^}]*)\}\s*${typedefName}\s*;`);
  const m = source.match(re);
  if (!m) throw new Error(`enum ${typedefName} not found`);
  const entries = new Map<string, number>();
  let next = 0;
  for (const raw of stripComments(m[1]!).split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const eq = item.match(/^(\w+)\s*=\s*(.+)$/s);
    if (eq) {
      const value = Number(eq[2]!.trim());
      if (!Number.isInteger(value)) throw new Error(`cannot eval ${item} in ${typedefName}`);
      entries.set(eq[1]!, value);
      next = value + 1;
    } else {
      if (!/^\w+$/.test(item)) throw new Error(`unexpected enum item: ${item}`);
      entries.set(item, next++);
    }
  }
  return entries;
}

const SPR = parseEnum(infoH, 'spritenum_t');
const S = parseEnum(infoH, 'statenum_t');
const MT = parseEnum(infoH, 'mobjtype_t');
const SFX = parseEnum(soundsH, 'sfxenum_t');
const MUS = parseEnum(soundsH, 'musicenum_t');
const MF = parseEnum(pMobjH, 'mobjflag_t');

// Evaluates a C integer constant expression using the parsed symbol tables.
const symbols = new Map<string, number>([
  ...SPR, ...S, ...MT, ...SFX, ...MF,
  ['FRACUNIT', 65536],
]);
function evalExpr(expr: string): number {
  const substituted = expr.replace(/[A-Za-z_]\w*/g, (id) => {
    const v = symbols.get(id);
    if (v === undefined) throw new Error(`unknown identifier ${id} in ${expr}`);
    return String(v);
  });
  if (!/^[\d\s+\-*/|()x]+$/.test(substituted)) {
    throw new Error(`unsafe expression: ${expr} -> ${substituted}`);
  }
  const value = new Function(`return (${substituted});`)() as number;
  if (!Number.isInteger(value)) throw new Error(`non-integer result for ${expr}`);
  return value;
}

// --- sprnames ---------------------------------------------------------
const sprMatch = infoC.match(/sprnames\[[^\]]*\]\s*=\s*\{([\s\S]*?)\};/);
if (!sprMatch) throw new Error('sprnames not found');
const sprnames = [...sprMatch[1]!.matchAll(/"(\w{4})"/g)].map((m) => m[1]!);
if (sprnames.length !== SPR.get('NUMSPRITES')) {
  throw new Error(`sprnames: ${sprnames.length} names vs NUMSPRITES=${SPR.get('NUMSPRITES')}`);
}

// --- states -----------------------------------------------------------
const statesMatch = infoC.match(/state_t\s+states\[[^\]]*\]\s*=\s*\{([\s\S]*?)\n\};/);
if (!statesMatch) throw new Error('states not found');
const stateRe =
  /\{\s*(SPR_\w+)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*\{\s*(NULL|A_\w+)\s*\}\s*,\s*(S_\w+)\s*,\s*([^,]+?)\s*,\s*([^,}]+?)\s*\}/g;
type StateRow = [number, number, number, string | null, number, number, number];
const states: StateRow[] = [];
const actionNames = new Set<string>();
for (const m of statesMatch[1]!.matchAll(stateRe)) {
  const action = m[4] === 'NULL' ? null : m[4]!;
  if (action) actionNames.add(action);
  states.push([
    evalExpr(m[1]!), evalExpr(m[2]!), evalExpr(m[3]!),
    action,
    evalExpr(m[5]!), evalExpr(m[6]!), evalExpr(m[7]!),
  ]);
}
// statenum_t ends with NUMSTATES; states[] must match the enum exactly.
if (states.length !== S.get('NUMSTATES')) {
  throw new Error(`states: parsed ${states.length}, expected ${S.get('NUMSTATES')}`);
}

// --- mobjinfo ---------------------------------------------------------
const FIELDS = [
  'doomednum', 'spawnstate', 'spawnhealth', 'seestate', 'seesound',
  'reactiontime', 'attacksound', 'painstate', 'painchance', 'painsound',
  'meleestate', 'missilestate', 'deathstate', 'xdeathstate', 'deathsound',
  'speed', 'radius', 'height', 'mass', 'damage', 'activesound', 'flags',
  'raisestate',
] as const;
const mobjMatch = infoC.match(/mobjinfo_t\s+mobjinfo\[[^\]]*\]\s*=\s*\{([\s\S]*?)\n\};/);
if (!mobjMatch) throw new Error('mobjinfo not found');
const mobjBody = mobjMatch[1]!;
// Each entry: `{  // MT_NAME` ... 23 comma-separated expressions ... `}`
const entryRe = /\{\s*\/\/\s*(MT_\w+)([\s\S]*?)\n\s*\}/g;
type MobjRow = { name: string; values: number[] };
const mobjinfo: MobjRow[] = [];
for (const m of mobjBody.matchAll(entryRe)) {
  const values = stripComments(m[2]!)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(evalExpr);
  if (values.length !== FIELDS.length) {
    throw new Error(`${m[1]}: ${values.length} fields, expected ${FIELDS.length}`);
  }
  mobjinfo.push({ name: m[1]!, values });
}
if (mobjinfo.length !== MT.get('NUMMOBJTYPES')) {
  throw new Error(`mobjinfo: parsed ${mobjinfo.length}, expected ${MT.get('NUMMOBJTYPES')}`);
}

// --- sounds -----------------------------------------------------------
// S_sfx rows: SOUND("name", priority) or SOUND_LINK("name", priority, sfx_x, pitch, volume)
const sfxRows: { name: string; priority: number; link: number | null }[] = [];
const sfxBody = soundsC.match(/S_sfx\[\]\s*=\s*\{([\s\S]*?)\n\};/);
if (!sfxBody) throw new Error('S_sfx not found');
for (const m of sfxBody[1]!.matchAll(
  /SOUND(_LINK)?\(\s*"(\w+)"\s*,\s*(\d+)(?:\s*,\s*(sfx_\w+)\s*,[^)]*)?\)/g,
)) {
  sfxRows.push({
    name: m[2]!,
    priority: Number(m[3]),
    link: m[4] ? evalExpr(m[4]) : null,
  });
}
if (sfxRows.length !== SFX.get('NUMSFX')) {
  throw new Error(`S_sfx: parsed ${sfxRows.length}, expected ${SFX.get('NUMSFX')}`);
}
const musicNames = [...(soundsC.match(/S_music\[\]\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '')
  .matchAll(/MUSIC\((?:"(\w+)"|NULL)\)/g)].map((m) => m[1] ?? null);
if (musicNames.length !== MUS.get('NUMMUSIC')) {
  throw new Error(`S_music: parsed ${musicNames.length}, expected ${MUS.get('NUMMUSIC')}`);
}

// --- emit -------------------------------------------------------------
function emitEnum(name: string, entries: Map<string, number>, stripPrefix: string): string {
  const lines = [...entries]
    .map(([k, v]) => `  ${k.startsWith(stripPrefix) ? k.slice(stripPrefix.length) : k}: ${v},`)
    .join('\n');
  return `export const ${name} = {\n${lines}\n} as const;\n`;
}

const header = `// GENERATED by tools/gen-info.ts from Chocolate Doom (GPL-2). Do not edit.\n`;

const infoOut = `${header}
// Sprite/state/mobjtype enums (prefixes SPR_/S_/MT_ stripped).
${emitEnum('SPR', SPR, 'SPR_')}
${emitEnum('S', S, 'S_')}
${emitEnum('MT', MT, 'MT_')}
// mobj flags (prefix MF_ stripped).
${emitEnum('MF', MF, 'MF_')}
export const sprnames: readonly string[] = ${JSON.stringify(sprnames)};

// states[i] = [sprite, frame, tics, action, nextstate, misc1, misc2]
export type StateRow = readonly [
  sprite: number, frame: number, tics: number, action: string | null,
  nextstate: number, misc1: number, misc2: number,
];
export const states: readonly StateRow[] = [
${states
  .map((s, i) => `  [${s.map((v) => JSON.stringify(v)).join(',')}], // ${[...S.keys()][i]}`)
  .join('\n')}
];

// Action function names referenced by states; the sim registers a
// dispatch table keyed by these.
export const actionNames: readonly string[] = ${JSON.stringify([...actionNames].sort())};

export interface MobjInfo {
${FIELDS.map((f) => `  readonly ${f}: number;`).join('\n')}
}
export const mobjinfo: readonly MobjInfo[] = [
${mobjinfo
  .map(
    (row) =>
      `  { ${row.values.map((v, i) => `${FIELDS[i]}: ${v}`).join(', ')} }, // ${row.name}`,
  )
  .join('\n')}
];
`;

const soundsOut = `${header}
${emitEnum('SFX', SFX, 'sfx_')}
${emitEnum('MUS', MUS, 'mus_')}
export interface SfxInfo {
  readonly name: string;      // lump is DS<name>
  readonly priority: number;
  readonly link: number | null;
}
export const sfxinfo: readonly SfxInfo[] = [
${sfxRows
  .map((r) => `  { name: ${JSON.stringify(r.name)}, priority: ${r.priority}, link: ${r.link} },`)
  .join('\n')}
];
export const musicNames: readonly (string | null)[] = ${JSON.stringify(musicNames)};
`;

const outDir = join(root, 'src', 'sim', 'data');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'info.gen.ts'), infoOut);
writeFileSync(join(outDir, 'sounds.gen.ts'), soundsOut);
console.log(
  `info.gen.ts: ${sprnames.length} sprites, ${states.length} states, ` +
    `${mobjinfo.length} mobj types, ${actionNames.size} actions\n` +
    `sounds.gen.ts: ${sfxRows.length} sfx, ${musicNames.length} music`,
);
