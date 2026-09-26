import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The app lives in web/ and builds to web/dist, which the Worker serves as
// static assets. In dev, /api goes to `wrangler dev` on :8787.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
})
