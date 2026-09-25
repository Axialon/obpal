/**
 * ob.Pal Link build (Chromium MV3). `vite build` here produces extension/dist, ready for "Load unpacked":
 *  - popup.html, offscreen.html and the module service worker (background.js) from one multi-entry build,
 *  - the content scripts (bridge.js, page.js) as self-contained classic IIFEs, one build each,
 *  - manifest.json and PNG action icons rendered from public/favicon.svg,
 * then checks that the manifest is MV3 and every file it (or a page) references exists.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'
import { ICON_SIZES, renderIcons } from './scripts/icons.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const outDir = resolve(root, 'dist')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }
const TARGET = 'chrome120'

/** Content scripts cannot be ES modules or share chunks: each is bundled alone as an IIFE. */
const CONTENT_SCRIPTS = [
  { entry: 'src/content/bridge.ts', file: 'bridge.js', name: 'obpalLinkBridge' },
  { entry: 'src/content/page.ts', file: 'page.js', name: 'obpalLinkPage' },
]

const icons = Object.fromEntries(ICON_SIZES.map((s: number) => [String(s), `icons/icon-${s}.png`]))

const manifest = {
  manifest_version: 3,
  name: 'ob.Pal Link',
  short_name: 'ob.Pal Link',
  version: pkg.version,
  description: 'Your phone as a controller for any website: Gamepad API games, 3D viewers and keyboard games. Pair by QR.',
  minimum_chrome_version: '120',
  homepage_url: 'https://obpal.blackboxes.net',
  icons,
  action: { default_title: 'ob.Pal Link', default_popup: 'popup.html', default_icon: icons },
  background: { service_worker: 'background.js', type: 'module' },
  permissions: ['offscreen', 'storage', 'activeTab', 'scripting'],
  host_permissions: ['https://obpal.blackboxes.net/*'],
  optional_host_permissions: ['<all_urls>'],
  // Bundled code only: no eval, no remote scripts; network limited to the ob.Pal service.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' https://obpal.blackboxes.net wss://obpal.blackboxes.net",
  },
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

/** Fail the build unless dist is a loadable MV3 extension: manifest v3, every referenced file present, CSP-safe scripts. */
function verifyDist(dir: string) {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
  const m = JSON.parse(read('manifest.json')) as typeof manifest
  const problems: string[] = []
  if (m.manifest_version !== 3) problems.push('manifest_version is not 3')
  const refs = new Set<string>([
    m.action.default_popup, m.background.service_worker, ...Object.values(m.icons), ...Object.values(m.action.default_icon),
    'offscreen.html', ...CONTENT_SCRIPTS.map((c) => c.file),
  ])
  for (const html of ['popup.html', 'offscreen.html']) {
    for (const [, ref] of read(html).matchAll(/\b(?:src|href)="\/?([^"?#:]+)"/g)) refs.add(ref)
  }
  for (const file of walk(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(file, 'utf8')
    for (const [, spec] of src.matchAll(/(?:\bfrom|\bimport|\bnew URL)\s*\(?\s*["']([^"']+\.js)["']/g)) {
      const target = spec.startsWith('/') ? join(dir, spec) : resolve(dirname(file), spec)
      refs.add(relative(dir, target).replace(/\\/g, '/'))
    }
    if (/\beval\(|\bnew Function\(/.test(src)) problems.push(`${relative(dir, file)} uses eval or new Function`)
  }
  for (const c of CONTENT_SCRIPTS) if (/^\s*(?:import|export)\b/m.test(read(c.file))) problems.push(`${c.file} is not a classic script`)
  for (const ref of refs) if (!existsSync(join(dir, ref))) problems.push(`missing ${ref}`)
  if (problems.length) throw new Error(`ob.Pal Link: dist check failed\n  ${problems.join('\n  ')}`)
  console.log(`ob.Pal Link: manifest v3 OK, ${refs.size} referenced files present in ${dir}`)
}

function extension(): Plugin {
  let wrote = false
  return {
    name: 'obpal-link-extension',
    apply: 'build',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` })
      for (const { size, png } of await renderIcons()) this.emitFile({ type: 'asset', fileName: `icons/icon-${size}.png`, source: png })
    },
    writeBundle() {
      wrote = true
    },
    async closeBundle() {
      if (!wrote) return
      for (const c of CONTENT_SCRIPTS) {
        await build({
          configFile: false,
          root,
          publicDir: false,
          logLevel: 'warn',
          build: {
            outDir, emptyOutDir: false, copyPublicDir: false, target: TARGET, sourcemap: false, minify: false,
            lib: { entry: resolve(root, c.entry), formats: ['iife'], name: c.name, fileName: () => c.file },
          },
        })
      }
      verifyDist(outDir)
    },
  }
}

export default defineConfig({
  root,
  base: '/',
  publicDir: false,
  plugins: [extension()],
  worker: { format: 'es' },
  build: {
    outDir,
    emptyOutDir: true,
    target: TARGET,
    modulePreload: false,
    sourcemap: false,
    // Readable output: people installing from GitHub (and store reviewers) can read exactly what runs.
    minify: false,
    rolldownOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        offscreen: resolve(root, 'offscreen.html'),
        background: resolve(root, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
