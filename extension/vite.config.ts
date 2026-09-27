/**
 * ob.Pal Link build (Chromium MV3). `vite build` here produces extension/dist, ready for "Load unpacked":
 *  - popup.html, options.html, offscreen.html and the module service worker (background.js) from one multi-entry build,
 *  - the classic scripts as self-contained IIFEs, one build each: the content scripts (bridge.js, page.js) and the
 *    options page's first-paint script (first-paint.js, which puts the last look on before the page is drawn),
 *  - manifest.json and PNG action icons rendered from public/favicon.svg, and the bundled fonts' licences,
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

/**
 * Classic scripts cannot be ES modules or share chunks: each is bundled alone as an IIFE. The content scripts, and the
 * first-paint script, which the options page's <head> loads as a plain <script> (MV3 allows no inline script) so that
 * it runs before the first paint; a module script is deferred and may run after it.
 */
const CLASSIC_SCRIPTS = [
  { entry: 'src/content/bridge.ts', file: 'bridge.js', name: 'obpalLinkBridge' },
  { entry: 'src/content/page.ts', file: 'page.js', name: 'obpalLinkPage' },
  { entry: 'src/ui/first-paint.ts', file: 'first-paint.js', name: 'obpalLinkFirstPaint' },
]
/** The bundled fonts' licences (SIL Open Font License 1.1, which travels with the fonts), shipped beside them. */
const FONT_LICENCES = readdirSync(resolve(root, 'src/fonts')).filter((f) => /^OFL-.+\.txt$/.test(f))

const icons = Object.fromEntries(ICON_SIZES.map((s: number) => [String(s), `icons/icon-${s}.png`]))

/**
 * The extension's public key, which fixes its ID (jnnpcnoilofjaffabnhecfokjjknlemg) for every unpacked and
 * packed copy, so the ob.Pal Desktop helper's native messaging manifest can allow it by ID. The matching
 * private key is not in the repository (extension/scripts/key.mjs makes and reads it); a fork that cannot
 * use it makes its own pair, puts the new ID in desktop/src/win/install.rs, and reinstalls the helper.
 */
const EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzYnsUcmTpnHdiAFCNZ+Pre5xIlcJE5af7+QJauRqGZBUCGhbfKwLhzSKdlUXxaPzil+G/bbhsaomm6Z701TufnMoyYWpIl6SwHxPR8XxtUiFKZLkVlYNbptp1oOl53onNGx2XrgGCHnX6hBH6gGvS+gVWDtvOCKFzcH+XmkqM/YkwmHuIhkepm3TMervmAa5aPpWTr0LeXbtrGJ3jjVjjuqogXJsKbUyMSCKY8AJ3isVUIM3xc93+EL0M8Yk2E2yuBNogEMtW00XYWsBbNBot6eNKlg6plTi1XpS8LGy52hm1PElGp1pd6F91Rp45YupcH6li69qk5lBdrhHh1/pSwIDAQAB'

const manifest = {
  manifest_version: 3,
  name: 'ob.Pal Link',
  short_name: 'ob.Pal Link',
  version: pkg.version,
  // Also the Chrome Web Store summary: 132 characters at most (extension/store/listing.md).
  description: 'Use your phone as a controller for websites: games, 3D viewers and more. Add ob.Pal Desktop to control your whole PC. Pair by QR.',
  minimum_chrome_version: '120',
  homepage_url: 'https://obpal.blackboxes.net',
  key: EXTENSION_KEY,
  icons,
  action: { default_title: 'ob.Pal Link', default_popup: 'popup.html', default_icon: icons },
  background: { service_worker: 'background.js', type: 'module' },
  options_ui: { page: 'options.html', open_in_tab: true },
  permissions: ['offscreen', 'storage', 'activeTab', 'scripting'],
  // The PC target talks to the ob.Pal Desktop helper; asked for when the PC target is first chosen.
  optional_permissions: ['nativeMessaging'],
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
    m.action.default_popup, m.background.service_worker, m.options_ui.page, ...Object.values(m.icons), ...Object.values(m.action.default_icon),
    'offscreen.html', ...CLASSIC_SCRIPTS.map((c) => c.file), ...FONT_LICENCES.map((f) => `assets/${f}`),
  ])
  if (!/^[A-Za-z0-9+/]+=*$/.test(m.key) || m.key.length < 300) problems.push('manifest key is not a base64 public key')
  for (const html of ['popup.html', 'offscreen.html', 'options.html']) {
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
  for (const c of CLASSIC_SCRIPTS) if (/^\s*(?:import|export)\b/m.test(read(c.file))) problems.push(`${c.file} is not a classic script`)
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
      for (const f of FONT_LICENCES) this.emitFile({ type: 'asset', fileName: `assets/${f}`, source: readFileSync(resolve(root, 'src/fonts', f)) })
    },
    writeBundle() {
      wrote = true
    },
    async closeBundle() {
      if (!wrote) return
      for (const c of CLASSIC_SCRIPTS) {
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
        options: resolve(root, 'options.html'),
        background: resolve(root, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
