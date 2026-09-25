import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 5175, strictPort: true },
  environments: {
    client: {
      build: {
        // Controller floor from PLAN.md: Safari 15, Chromium 95, Firefox 115.
        target: ['safari15', 'chrome95', 'firefox115', 'edge95'],
        rollupOptions: {
          input: { index: 'index.html', controller: 'p/index.html', viewer: 'view/index.html', sponsor: 'sponsor/index.html', donate: 'donate/index.html', link: 'link/index.html', privacy: 'privacy/index.html' },
        },
      },
    },
  },
})
