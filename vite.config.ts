import { defineConfig } from 'vite';

export default defineConfig({
  // WADs sit in the project root and are never bundled into dist/.
  // Dev serves them directly: /DOOM2.WAD and /freedm.wad by name, plus
  // /wad/<name> as the dev equivalent of the production server's
  // registered-WAD route (so ?wad=DOOM2.WAD works in dev too).
  publicDir: false,
  server: {
    port: 5173,
  },
  plugins: [
    {
      name: 'serve-local-wads',
      configureServer(server) {
        const serveWad = async (name: string, res: import('http').ServerResponse) => {
          const { readFile } = await import('node:fs/promises');
          const { basename } = await import('node:path');
          try {
            if (!/\.wad$/i.test(name)) throw new Error('not a wad');
            const buf = await readFile(new URL(`./${basename(name)}`, import.meta.url));
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(buf);
          } catch {
            res.statusCode = 404;
            res.end(`${name} not found in project root`);
          }
        };
        server.middlewares.use('/DOOM2.WAD', (_req, res) => void serveWad('DOOM2.WAD', res));
        server.middlewares.use('/freedm.wad', (_req, res) => void serveWad('freedm.wad', res));
        server.middlewares.use('/wad', (req, res) =>
          void serveWad(decodeURIComponent((req.url ?? '/').slice(1)), res),
        );
      },
    },
  ],
});
