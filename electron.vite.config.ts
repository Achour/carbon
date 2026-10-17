import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `buddy` is the desktop buddy's own window (`main/buddy.ts`), which
        // gets four calls rather than the whole `window.api`.
        input: {
          index: resolve('src/preload/index.ts'),
          buddy: resolve('src/preload/buddy.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // `remote` is the phone client main serves for Remote access
        // (`main/remoteAccess.ts`). A second page of the same build rather than
        // a separate one, so it shares the renderer's aliases and dependencies
        // and ships inside out/renderer with no extra packaging step.
        input: {
          index: resolve('src/renderer/index.html'),
          remote: resolve('src/renderer/remote.html'),
          buddy: resolve('src/renderer/buddy.html')
        }
      }
    }
  }
})
