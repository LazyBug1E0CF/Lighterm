import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.LIGHTERM_SERVER_URL || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env.LIGHTERM_SERVER_URL || 'http://127.0.0.1:8080',
        ws: true,
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ['**/src-tauri/**', '**/crates/**'],
    },
    warmup: {
      clientFiles: [
        './index.html',
        './src/main.tsx',
        './src/App.tsx',
        './src/index.css',
        './src/plugins/index.ts',
      ],
    },
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'zustand',
      'lucide-react',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-search',
      '@xterm/addon-web-links',
      '@xterm/addon-webgl',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/plugin-dialog',
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
