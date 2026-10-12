/*
  Сборка приложения. Ключевые решения:
   • во время разработки /api проксируется на FastAPI — браузер обращается
     только к своему origin, никаких localhost в коде страницы;
   • allowedHosts: true — приложение открывают и со стенда, и по туннелю,
     поэтому не ограничиваем список хостов (Mini App живёт за https-доменом);
   • сборка кладётся в dist: этот каталог раздаёт FastAPI (api/server.py)
     или nginx из webapp/Dockerfile.
*/
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_DEV_API || 'http://127.0.0.1:8000'

  return {
    plugins: [vue()],
    base: './',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '0.0.0.0',
      port: Number(env.VITE_PORT || 3000),
      strictPort: true,
      allowedHosts: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  }
})
