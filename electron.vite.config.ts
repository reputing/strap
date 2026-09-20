import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer')
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          updater: resolve('src/main/updater/updater-process.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      minify: 'esbuild',
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react()],
    build: {
      // electron-vite leaves the renderer unminified by default. An Electron
      // app parses its bundle from disk on every cold start, so this is real
      // startup time rather than transfer size.
      minify: 'esbuild',
      target: 'chrome128',
      cssMinify: true,
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html')
        },
        output: {
          // Keep the framework in its own chunk so a page-level change does not
          // invalidate it, and so the overlay entry never pulls it in.
          manualChunks(id) {
            if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
              return 'framework';
            }
            return undefined;
          }
        }
      }
    }
  }
});
