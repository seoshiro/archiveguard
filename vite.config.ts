import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  build: { rolldownOptions: { input: ['index.html', 'privacy.html'] } },
  plugins: [react(), { name: 'production-privacy-policy', transformIndexHtml: { order: 'post', handler: (_html, context) => context.server ? [] : [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'" }, injectTo: 'head' }] } }],
  server: { host: '127.0.0.1', port: 4318, strictPort: true },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
