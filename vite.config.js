import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // `mapbox-gl` is intentionally isolated into its own vendor chunk and still minifies above
    // Vite's default warning threshold. Keep warnings focused on unexpected growth elsewhere.
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/mapbox-gl/')) return 'mapbox-gl'
          if (id.includes('node_modules/react-map-gl/')) return 'react-map-gl'
          if (id.includes('node_modules/react/')) return 'react-vendor'
          if (id.includes('node_modules/react-dom/')) return 'react-vendor'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
