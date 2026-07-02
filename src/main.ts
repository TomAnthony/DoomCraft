// Boot entry. During early milestones this launches the WAD debug viewer;
// it will become the lobby + game bootstrap.

import { runWadViewer } from './debug/wadviewer.ts';

const app = document.getElementById('app')!;
runWadViewer(app).catch((err) => {
  app.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  throw err;
});
