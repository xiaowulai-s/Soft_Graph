/// <reference types="vite/client" />

import type { SoftGraphApi } from '@shared/ipc'

declare global {
  interface Window {
    api: SoftGraphApi
    apiExtra: {
      onJunkSummaryChanged(cb: (s: unknown) => void): () => void
    }
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
