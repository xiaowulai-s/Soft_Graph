import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const alias = {
  '@shared': resolve('packages/shared'),
  '@scanner': resolve('packages/scanner'),
  '@junk': resolve('packages/junk'),
  '@graph-core': resolve('packages/graph-core'),
  '@rules': resolve('packages/rules'),
  '@main': resolve('apps/desktop/src/main'),
  '@renderer': resolve('apps/desktop/src/renderer/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      lib: { entry: resolve('apps/desktop/src/main/index.ts') },
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      lib: { entry: resolve('apps/desktop/src/preload/index.ts') },
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    resolve: { alias },
    plugins: [vue()],
    worker: { format: 'es' },
    build: {
      rollupOptions: {
        input: {
          index: resolve('apps/desktop/src/renderer/index.html'),
          float: resolve('apps/desktop/src/renderer/float.html')
        }
      }
    }
  }
})
