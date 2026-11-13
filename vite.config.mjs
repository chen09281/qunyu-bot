import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = `http://127.0.0.1:${env.PORT || 3080}`;
  return {
    root: fileURLToPath(new URL('./frontend', import.meta.url)),
    plugins: [vue()],
    build: { outDir: '../dist', emptyOutDir: true },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: true, headers: { origin: env.PUBLIC_ORIGIN || target } },
        '/onebot': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true }
      }
    }
  };
});
