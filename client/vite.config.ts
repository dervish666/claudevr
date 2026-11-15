import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The bridge serves from CLAUDEVR_CLIENT_DIR when it is set (an absolute
// path, as scripts/dev.mjs passes it), so a watch build lands where it reads.
const outDir = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CLAUDEVR_CLIENT_DIR ?? 'dist'

// Two pages, both served by the bridge: the HUD at / and the headset probe at /probe.
export default defineConfig({
  plugins: [react()],
  // @iwer/devui and @iwer/sem (the emulator, pulled in by @react-three/xr)
  // bring their own three; two copies in one page break instanceof checks.
  resolve: { dedupe: ['three'] },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        hud: fileURLToPath(new URL('index.html', import.meta.url)),
        probe: fileURLToPath(new URL('probe.html', import.meta.url)),
      },
    },
  },
})
