import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8080', '/health': 'http://127.0.0.1:8080' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8080', '/health': 'http://127.0.0.1:8080', '/livez': 'http://127.0.0.1:8080' } },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(moduleId) {
          if (moduleId.includes('/node_modules/maplibre-gl/')) return 'map-engine'
        },
      },
    },
  },
  test: { environment: 'jsdom', setupFiles: './src/testSetup.ts' },
})
