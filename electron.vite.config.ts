import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        // The diarization worker is a second entry: it runs as its own
        // utilityProcess, so it must not be bundled into the main script.
        input: {
          index: resolve('src/main/index.ts'),
          diarize: resolve('src/main/workers/diarize.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
