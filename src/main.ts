// Boot entry. Debug views while the game is under construction:
//   /            -> map fly-through (default MAP01, ?map=MAP07)
//   /?view=wad   -> WAD asset debug viewer

import { runMapViewer } from './debug/mapviewer.ts';
import { runWadViewer } from './debug/wadviewer.ts';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

const run =
  params.get('view') === 'wad'
    ? runWadViewer(app)
    : runMapViewer(app, (params.get('map') ?? 'MAP01').toUpperCase());

run.catch((err) => {
  app.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  throw err;
});
