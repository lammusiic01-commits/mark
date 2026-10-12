import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// В разработке API живёт на том же порту, что и в продакшене: /api → FastAPI на 127.0.0.1:8000
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
})
