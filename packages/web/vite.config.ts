import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { resolve } from 'node:path';

const CLEAN_URLS: Record<string, string> = {
  '/om': '/om.html',
  '/om/': '/om.html',
};

function cleanUrls(): Plugin {
  return {
    name: 'byradar-clean-urls',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const target = req.url ? CLEAN_URLS[req.url] : undefined;
        if (target) req.url = target;
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const root = resolve(__dirname, '../..');
  const env = loadEnv(mode, root, '');
  return {
    root: __dirname,
    envDir: root,
    plugins: [cleanUrls()],
    server: { port: 5173, strictPort: false },
    define: {
      __MAPTILER_KEY__: JSON.stringify(env.VITE_MAPTILER_KEY ?? ''),
      __MAPTILER_STYLE__: JSON.stringify(env.VITE_MAPTILER_STYLE ?? 'dataviz-v4-dark'),
      __DATA_URL__: JSON.stringify(env.VITE_DATA_URL ?? 'http://localhost:8787/data'),
      __API_URL__: JSON.stringify(env.VITE_API_URL ?? 'http://localhost:8787'),
      __WS_URL__: JSON.stringify(env.VITE_WS_URL ?? 'ws://localhost:8787/live'),
      __CF_BEACON_TOKEN__: JSON.stringify(env.VITE_CF_BEACON_TOKEN ?? ''),
    },
    build: {
      target: 'es2022',
      sourcemap: mode !== 'production',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          om: resolve(__dirname, 'om.html'),
        },
      },
    },
  };
});
