// Boot entry. Debug views while the game is under construction:
//   /            -> playable walk mode (default MAP01, ?map=MAP07)
//   /?view=fly   -> free-fly camera
//   /?view=wad   -> WAD asset debug viewer

import { runMapViewer } from './debug/mapviewer.ts';
import { runPlayViewer } from './debug/playviewer.ts';
import { runWadViewer } from './debug/wadviewer.ts';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const mapName = (params.get('map') ?? 'MAP01').toUpperCase();

const run =
  params.get('view') === 'wad'
    ? runWadViewer(app)
    : params.get('view') === 'fly'
      ? runMapViewer(app, mapName)
      : runPlayViewer(app, mapName);

run.catch((err) => {
  app.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  throw err;
});
