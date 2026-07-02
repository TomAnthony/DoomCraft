import { defineConfig } from 'vite';

export default defineConfig({
  // DOOM2.WAD sits in the project root; serve it in dev so the client can
  // fetch it without a file picker. It is never bundled into dist/.
  publicDir: false,
  server: {
    port: 5173,
  },
  plugins: [
    {
      name: 'serve-local-wad',
      configureServer(server) {
        server.middlewares.use('/DOOM2.WAD', async (_req, res) => {
          const { readFile } = await import('node:fs/promises');
          try {
            const buf = await readFile(new URL('./DOOM2.WAD', import.meta.url));
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(buf);
          } catch {
            res.statusCode = 404;
            res.end('DOOM2.WAD not found in project root');
          }
        });
      },
    },
  ],
});
