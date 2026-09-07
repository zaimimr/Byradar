import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const root = resolve(__dirname, '../..');
  const env = loadEnv(mode, root, '');
  return {
    root: __dirname,
    envDir: root,
    server: { port: 5173, strictPort: false },
    define: {
      __MAPTILER_KEY__: JSON.stringify(env.VITE_MAPTILER_KEY ?? ''),
      __MAPTILER_STYLE__: JSON.stringify(env.VITE_MAPTILER_STYLE ?? 'dataviz-v4-dark'),
      __DATA_URL__: JSON.stringify(env.VITE_DATA_URL ?? 'http://localhost:8787/data'),
      __API_URL__: JSON.stringify(env.VITE_API_URL ?? 'http://localhost:8787'),
      __WS_URL__: JSON.stringify(env.VITE_WS_URL ?? 'ws://localhost:8787/live'),
    },
    build: { target: 'es2022', sourcemap: true },
  };
});
