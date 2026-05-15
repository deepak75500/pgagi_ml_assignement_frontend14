import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    hmr: {
      protocol: 'http',
      host: '192.168.1.2',
      port: 5173,
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  }
})
