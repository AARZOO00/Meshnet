import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    host: '0.0.0.0',   // bind to all interfaces for LAN testing
    port: 5173,
    strictPort: false,
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'd3-vendor':    ['d3'],
          'leaflet':      ['leaflet'],
          'socket':       ['socket.io-client'],
        },
      },
    },
  },

  // Allow importing leaflet images as URLs for marker icon fix
  assetsInclude: ['**/*.png', '**/*.jpg', '**/*.svg'],

  optimizeDeps: {
    include: ['d3', 'leaflet', 'qrcode', 'jsqr', 'socket.io-client', 'uuid'],
  },
});
