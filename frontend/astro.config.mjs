import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  build: {
    format: 'directory'
  },
  server: {
    port: 4321,
    host: true
  },
  vite: {
    server: {
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
          changeOrigin: false,
          xfwd: true
        }
      }
    }
  }
});
