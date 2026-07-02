// Boot entry.
//   /             -> solo game (default MAP01, ?map=MAP07 or ?map=7)
//   /?view=walk   -> movement-only debug mode (no monsters)
//   /?view=fly    -> free-fly camera
//   /?view=wad    -> WAD asset debug viewer

import { runMapViewer } from './debug/mapviewer.ts';
import { runPlayViewer } from './debug/playviewer.ts';
import { runWadViewer } from './debug/wadviewer.ts';
import { runGame } from './game/game.ts';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const mapParam = (params.get('map') ?? 'MAP01').toUpperCase();
const mapName = /^\d+$/.test(mapParam) ? `MAP${mapParam.padStart(2, '0')}` : mapParam;

// Netplay: ?server=ws://host:8666 creates a room (add &map=7 to pick the
// map); ?server=...&room=CODE joins one. When the page is served by the
// relay itself, ?host (create) or ?room=CODE (join) suffice — the ws URL
// defaults to this origin.
const sameOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const server =
  params.get('server') ?? (params.has('host') || params.has('room') ? sameOrigin : null);
const net = server
  ? { url: server, room: params.get('room') ?? undefined }
  : undefined;

const run =
  params.get('view') === 'wad'
    ? runWadViewer(app)
    : params.get('view') === 'fly'
      ? runMapViewer(app, mapName)
      : params.get('view') === 'walk'
        ? runPlayViewer(app, mapName)
        : runGame(app, parseInt(mapName.slice(3), 10), net);

run.catch((err) => {
  app.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  throw err;
});
