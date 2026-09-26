import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Worker and scoring tests run in node; app tests opt into jsdom with a
// `// @vitest-environment jsdom` line.
export default defineConfig({
  plugins: [react()],
  test: { include: ['src/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'] },
})
