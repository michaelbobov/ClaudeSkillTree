import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Builds the Skill Tree webview into dist/webview/assets with stable file names so the
// extension host can reference them via asWebviewUri. Everything is bundled locally.
export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@shared': here('../src/shared') },
  },
  build: {
    outDir: here('../dist/webview'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    sourcemap: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: here('src/main.tsx'),
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) =>
          (info.names?.[0] ?? info.name ?? '').endsWith('.css') ? 'assets/index.css' : 'assets/[name][extname]',
      },
    },
  },
});
