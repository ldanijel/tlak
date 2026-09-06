import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg', 'tessdata/*.gz', 'tesseract/**/*'],
      manifest: {
        name: 'Tlak – osobno praćenje krvnog tlaka',
        short_name: 'Tlak',
        description: 'Praćenje krvnog tlaka i pulsa, offline, s online sinkronizacijom.',
        lang: 'hr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#fcfcfb',
        theme_color: '#2a78d6',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Novo mjerenje', url: '/new', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Fotografiraj tlakomjer', url: '/new/photo', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,gz}'],
        // Jezgra bez SIMD-a (stariji uređaji) ne ide u precache, nego se sprema pri prvom korištenju.
        globIgnores: ['**/tesseract-core.wasm.js'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          { urlPattern: /\/tesseract\/core\/.*\.wasm\.js$/, handler: 'CacheFirst', options: { cacheName: 'tesseract-core', expiration: { maxEntries: 4 } } },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
});
