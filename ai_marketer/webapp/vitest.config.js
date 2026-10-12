import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/* Конфигурация тестов: те же алиасы и плагины, что в сборке. */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.spec.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Проверки идут по одной: сценарии меняют состояние демо-данных
    fileParallelism: false,
    setupFiles: ['./tests/setup.js'],
    server: {
      deps: { inline: ['vue-router'] },
    },
  },
})
