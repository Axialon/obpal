import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const root = fileURLToPath(new URL('.', import.meta.url))

/** Files the phone needs to open the controller with no internet, besides the page's own build assets. */
const CONTROLLER_STATIC = ['/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']

/**
 * Builds the controller's service worker (src/sw/sw.ts) into <client outDir>/p/sw.js after the client bundle is
 * written, with the exact list of files the controller page loads (its HTML, every chunk it imports, its CSS)
 * baked in. The list's hash versions the cache, so a new deploy installs as a new version.
 */
function controllerServiceWorker(): Plugin {
  return {
    name: 'obpal-controller-sw',
    apply: 'build',
    async writeBundle(options, bundle) {
      if (this.environment?.name !== 'client' || !options.dir) return
      const html = bundle['p/index.html']
      if (!html || html.type !== 'asset') return
      const files = new Set<string>(['/p/'])
      const chunks = new Set<string>()
      for (const [, ref] of String(html.source).matchAll(/\b(?:src|href)="(\/assets\/[^"]+)"/g)) {
        files.add(ref)
        if (ref.endsWith('.js')) chunks.add(ref.slice(1))
      }
      // Every chunk reachable from the page, static or lazy, and the CSS those chunks pull in.
      for (const name of chunks) {
        const chunk = bundle[name]
        if (!chunk || chunk.type !== 'chunk') continue
        for (const dep of [...chunk.imports, ...chunk.dynamicImports]) { files.add(`/${dep}`); chunks.add(dep) }
        for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(`/${css}`)
      }
      for (const f of CONTROLLER_STATIC) files.add(f)
      const list = [...files]
      const version = createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12)
      await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'warn',
        define: { __PRECACHE__: JSON.stringify(list), __VERSION__: JSON.stringify(version) },
        build: {
          outDir: join(options.dir, 'p'), emptyOutDir: false, copyPublicDir: false, target: ['safari15', 'chrome95', 'firefox115'],
          sourcemap: false, minify: true,
          lib: { entry: resolve(root, 'src/sw/sw.ts'), formats: ['iife'], name: 'obpalSw', fileName: () => 'sw.js' },
        },
      })
      console.log(`controller service worker: ${list.length} files precached, cache version ${version}`)
    },
  }
}

export default defineConfig({
  plugins: [cloudflare(), controllerServiceWorker()],
  server: { port: 5175, strictPort: true },
  environments: {
    client: {
      build: {
        // Controller floor from PLAN.md: Safari 15, Chromium 95, Firefox 115.
        target: ['safari15', 'chrome95', 'firefox115', 'edge95'],
        rollupOptions: {
          input: { index: 'index.html', controller: 'p/index.html', viewer: 'view/index.html', sponsor: 'sponsor/index.html', donate: 'donate/index.html', link: 'link/index.html', privacy: 'privacy/index.html', sims: 'sim/index.html', simArm: 'sim/arm/index.html', simArena: 'sim/arena/index.html' },
        },
      },
    },
  },
})
