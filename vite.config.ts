import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'
import { markupBuild } from './scripts/markup-build.mjs'
import { pageWords, previewTags } from './scripts/lib/preview.mjs'
import { catalogueMarkup, deviceMarkup, faqMarkup, INDEXABLE_PAGES, jsonLd, robotsTxt, sitemapXml, structuredData } from './scripts/lib/seo.mjs'
import { loadSims } from './scripts/lib/load-sims.mjs'
import { cloudflare } from '@cloudflare/vite-plugin'
import { checkProfile, CONTROLLER_ID, CONTROLLER_IDS, CONTROLLERS, MOTION_UTILITIES, PROFILE_IDS, PROFILE_LIMITS, PROFILES, ROUTES, utilityKey } from './packages/core/src/catalogue'
import { APP_ACTIONS, BUTTON_TARGET, DEFAULT_BUTTONS, INPUT_ID, INPUT_OPTIONS, KEY_TARGETS, SMART_BUTTONS } from './packages/core/src/buttons'
import { Mode } from './packages/core/src/state'
import { BRIDGE_ROWS, EMBED, REPO, SYSTEM_ROWS, UTILITY_ROWS } from './src/catalogue/data'
import { DEVICE_MODELS, prototypeUrl } from './src/sim/kit/models'

const root = fileURLToPath(new URL('.', import.meta.url))
const { SIMS, DEVICE_IDS } = await loadSims(root, build)

/**
 * Files the phone needs to open the controller with no internet, besides the page's own build assets: the icons, and
 * the latin faces of its fonts (scripts/fonts.mjs; other subsets are cached as they're used).
 */
const CONTROLLER_STATIC = [
  '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
  '/fonts/inter-latin.woff2', '/fonts/plus-jakarta-sans-latin.woff2', '/fonts/jetbrains-mono-latin.woff2',
]

/**
 * Each page's Content Security Policy, as a <meta> the build puts first in its head; the headers (public/_headers)
 * add what a meta can't say (frame-ancestors). Scripts only from this origin, connections only to it (the room service
 * and its sockets, named for browsers whose 'self' leaves sockets out), fonts from here, no plugins, no frames, forms
 * only to here. Styles may be inline: the pages set style attributes. A page that needs more says so in CSP_EXTRA.
 * OBPAL_PUBLIC_ORIGIN names the service's origin for a build of your own.
 */
const PUBLIC_ORIGIN = process.env.OBPAL_PUBLIC_ORIGIN ?? 'https://obpal.blackboxes.net'
const CSP_EXTRA: Record<string, Record<string, string[]>> = {
  // The controller shows the thumbnails a screen's layout names, from any https host.
  '/p/index.html': { 'img-src': ['https:'] },
  // The viewer reads models and their textures from files the person opens.
  '/view/index.html': { 'connect-src': ['blob:', 'data:'] },
  // The arm sim drives a real arm through a rosbridge wherever the person points it, and shows the Blender models (next entry).
  '/sim/arm/index.html': { 'connect-src': ['ws:', 'wss:'], 'script-src': ["'wasm-unsafe-eval'"] },
  // The Blender models (src/sim/kit/prototype.ts) are meshopt-compressed, and their decoder compiles WebAssembly. Only
  // the arm and device sims load them, so only these two pages allow it.
  '/sim/device/index.html': { 'script-src': ["'wasm-unsafe-eval'"] },
}
function contentSecurityPolicy(page: string): string {
  const d: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'require-trusted-types-for': ["'script'"],
    'trusted-types': ['obpal-templates', 'obpal-camera'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", PUBLIC_ORIGIN.replace(/^http/, 'ws')],
    'media-src': ["'self'", 'blob:', 'data:'],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  }
  for (const [k, v] of Object.entries(CSP_EXTRA[page] ?? {})) d[k] = [...(d[k] ?? []), ...v]
  return Object.entries(d).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')
}

function pagePolicy(): Plugin {
  return {
    name: 'obpal-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => ({ html, tags: [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(ctx.path) }, injectTo: 'head-prepend' }] }),
    },
  }
}

/**
 * Every page but two gets src/ui/recover.ts: when a deploy has removed a lazy chunk the page still needs, it reloads
 * itself once. The phone controller is left out (its service worker serves the cached page whatever a reload does, and
 * the phone may be pairing), and so is the embed demo (its element recovers by itself, packages/host/src/embed.ts).
 */
const NO_RECOVERY = ['/p/index.html', '/embed/index.html']
function deployRecovery(): Plugin {
  return {
    name: 'obpal-deploy-recovery',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: (_html, ctx) => NO_RECOVERY.includes(ctx.path) ? [] : [{ tag: 'script', attrs: { type: 'module', src: '/src/ui/recover.ts' }, injectTo: 'head' }],
    },
  }
}

/**
 * The sims that wear a Blender mesh (the arm sim and the device sims) open with src/sim/kit/early.ts, ahead of their own
 * scripts: it starts the mesh's download and decoder, and shows the loading pill, while the rest of the page is still
 * arriving. A page's own scripts are one module graph that runs only when all of it has come, so this one is an entry
 * of its own (simEarly), named in the page just before them; its few imports are preloaded beside it.
 */
const EARLY_PAGES = ['/sim/device/index.html', '/sim/arm/index.html']
function simEarly(): Plugin {
  return {
    name: 'obpal-sim-early',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!EARLY_PAGES.includes(ctx.path)) return
        let tags = '<script type="module" src="/src/sim/kit/early.ts"></script>\n    '
        if (ctx.bundle) {
          const early = Object.values(ctx.bundle).find((c) => c.type === 'chunk' && c.isEntry && c.facadeModuleId?.endsWith('/src/sim/kit/early.ts'))
          if (!early || early.type !== 'chunk') throw new Error('The sims\' early script was not built')
          const files = new Set<string>()
          const walk = (name: string) => {
            const chunk = ctx.bundle![name]
            if (chunk?.type !== 'chunk' || files.has(name)) return
            files.add(name)
            chunk.imports.forEach(walk)
          }
          early.imports.forEach(walk)
          tags = [...files].map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`).join('\n    ') + (files.size ? '\n    ' : '')
            + `<script type="module" crossorigin src="/${early.fileName}"></script>\n    `
        }
        const first = html.indexOf('<script type="module"')
        if (first < 0) throw new Error(`${ctx.path} has no module script to run the early script before`)
        return html.slice(0, first) + tags + html.slice(first)
      },
    },
  }
}

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
        for (const dep of [...chunk.imports, ...chunk.dynamicImports]) {
          const target = bundle[dep]
          // The camera decoder is fetched only when scanning, including on a service worker's first install.
          if (target?.type === 'chunk' && Object.keys(target.modules).some((id) => /[\\/]jsqr[\\/]/i.test(id))) continue
          files.add(`/${dep}`); chunks.add(dep)
        }
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

/**
 * The embed, https://obpal.blackboxes.net/embed.js (packages/host/src/embed.ts: <obpal-remote> and window.obpal): an
 * ES module of its own, built after the client bundle as a library, so its lazy parts (the SDK, the QR code) sit beside
 * it in /assets/embed/ and load relative to it from any page. public/_headers lets other sites load them. The dev
 * server serves /embed.js from the source.
 */
function embedScript(): Plugin {
  const entry = resolve(root, 'packages/host/src/embed.ts')
  const version = (JSON.parse(readFileSync(join(root, 'packages/host/package.json'), 'utf8')) as { version: string }).version
  return {
    name: 'obpal-embed-script',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/embed.js') return next()
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.end("export * from '/packages/host/src/embed.ts'\n")
      })
    },
    async writeBundle(options) {
      if (this.environment?.name !== 'client' || !options.dir) return
      await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'warn',
        define: { __OBPAL_VERSION__: JSON.stringify(version) },
        build: {
          outDir: options.dir, emptyOutDir: false, copyPublicDir: false, target: ['safari15', 'chrome95', 'firefox115', 'edge95'],
          sourcemap: false, minify: true,
          lib: { entry, formats: ['es'], fileName: () => 'embed.js' },
          rollupOptions: { output: { chunkFileNames: 'assets/embed/[name]-[hash].js' } },
        },
      })
      console.log(`embed: /embed.js ${version}`)
    },
  }
}

/**
 * The control catalogue as files for people and AI agents, made from the code so they can't drift from it:
 * /catalogue.json (utilities, controllers, routes, built-in and community profiles, button bindings, systems, bridges) and
 * /profile.schema.json.
 * Community profiles are catalogue/profiles/<id>.json; the build checks each with checkProfile() and stops on a bad one.
 */
function catalogueFiles(): Plugin {
  const community = () => {
    const dir = join(root, 'catalogue/profiles')
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
      const { profile, errors } = checkProfile(JSON.parse(readFileSync(join(dir, f), 'utf8')))
      if (!profile) throw new Error(`catalogue/profiles/${f}: ${errors.join('; ')}`)
      if (`${profile.id}.json` !== f) throw new Error(`catalogue/profiles/${f}: name the file ${profile.id}.json`)
      return profile
    })
  }
  const settings = (routes: readonly string[]) => ({
    type: 'object',
    required: ['route', 'gain', 'curve', 'deadzone', 'invertY', 'edgeTurn'],
    additionalProperties: false,
    properties: {
      route: { enum: routes, description: 'Where this motion goes (CATALOGUE §2)' },
      gain: { type: 'number', minimum: PROFILE_LIMITS.gain[0], maximum: PROFILE_LIMITS.gain[1], description: 'Sensitivity' },
      curve: { type: 'number', minimum: PROFILE_LIMITS.curve[0], maximum: PROFILE_LIMITS.curve[1], description: 'Above 1 is finer near the centre' },
      deadzone: { type: 'number', minimum: PROFILE_LIMITS.deadzone[0], maximum: PROFILE_LIMITS.deadzone[1], description: 'The game’s own stick deadzone to jump over' },
      invertY: { type: 'boolean' },
      edgeTurn: { type: 'boolean', description: 'Point only: near a screen edge the right stick turns toward it' },
    },
  })
  const schema = () => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://obpal.blackboxes.net/profile.schema.json',
    title: 'ob.Pal controller profile',
    description: `A named set of motion settings, and optionally button bindings, a phone applies (CATALOGUE §3). Check one with checkProfile() in @obpal/core, then add it as catalogue/profiles/<id>.json in ${REPO}.`,
    type: 'object',
    required: ['id', 'name', 'for', 'on', 'aim', 'steer', 'point'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: PROFILE_LIMITS.id.source, not: { enum: [...PROFILE_IDS] }, description: 'New, lowercase, and the file name' },
      name: { type: 'string', minLength: 1, maxLength: PROFILE_LIMITS.name },
      for: { type: 'string', minLength: 1, maxLength: PROFILE_LIMITS.for, description: 'What it is for, one line' },
      on: { type: 'array', uniqueItems: true, items: { enum: [...MOTION_UTILITIES] }, description: 'Utilities it switches on when it applies' },
      ...Object.fromEntries(MOTION_UTILITIES.map((u) => [utilityKey(u), settings(ROUTES[u])])),
      controller: { enum: [...CONTROLLER_IDS], description: 'The controller it tunes (CATALOGUE §9.1); absent: face.gamepad' },
      buttons: {
        type: 'object',
        maxProperties: PROFILE_LIMITS.buttons,
        propertyNames: { pattern: INPUT_ID.source },
        additionalProperties: { type: 'string', pattern: BUTTON_TARGET.source },
        description: 'Physical inputs (key:<code>, media:<action>, pad:b<i>, back) bound to the controller’s controls (its `controls` in catalogue.json), a key on the screen (key-<code>), tray:<id>, app:<action> or none. Only what differs from its defaults (CATALOGUE §3).',
      },
    },
  })
  const modeName = new Map(Object.entries(Mode).map(([name, m]) => [m, name]))
  const catalogue = () => ({
    name: 'ob.Pal control catalogue',
    about: 'ob.Pal makes any phone the controller for what’s on a screen, with no app. This is everything such a phone can drive, and how: utilities, the controllers built from them, the routes motion takes, profiles, control systems and bridges, and the embed that puts ob.Pal on any page.',
    spec: `${REPO}/blob/main/spec/CATALOGUE.md`,
    protocol: `${REPO}/blob/main/spec/PROTOCOL.md`,
    profileSchema: 'https://obpal.blackboxes.net/profile.schema.json',
    addProfile: `Check it with checkProfile() in @obpal/core (or the builder at https://obpal.blackboxes.net/catalogue/#build), then add catalogue/profiles/<id>.json to ${REPO} in a pull request, or open an issue with the JSON.`,
    utilities: UTILITY_ROWS,
    // What a person picks on the phone (CATALOGUE §9.1): hosts suggest them in layout.controllers, the embed's `modes`
    // names them, and phones say which one they use in mode{c}.
    controllers: CONTROLLER_IDS.map((id) => ({ ...CONTROLLERS[id], modes: CONTROLLERS[id].modes.map((m) => modeName.get(m)) })),
    controllerId: CONTROLLER_ID.source,
    routes: ROUTES,
    limits: { gain: PROFILE_LIMITS.gain, curve: PROFILE_LIMITS.curve, deadzone: PROFILE_LIMITS.deadzone, id: PROFILE_LIMITS.id.source, name: PROFILE_LIMITS.name, for: PROFILE_LIMITS.for, buttons: PROFILE_LIMITS.buttons },
    // Physical buttons (CATALOGUE §3, `buttons`): the inputs a phone can hear, what they press on each controller by
    // default and, for a kind of device the phone recognises, on top of that.
    buttons: {
      inputId: INPUT_ID.source,
      target: BUTTON_TARGET.source,
      inputs: INPUT_OPTIONS,
      keys: KEY_TARGETS,
      app: APP_ACTIONS,
      defaults: DEFAULT_BUTTONS,
      smart: SMART_BUTTONS,
    },
    profiles: PROFILE_IDS.map((id) => PROFILES[id]),
    community: community(),
    systems: SYSTEM_ROWS,
    bridges: BRIDGE_ROWS,
    embed: EMBED,
  })
  const files = (): Record<string, string> => ({ '/catalogue.json': JSON.stringify(catalogue(), null, 2), '/profile.schema.json': JSON.stringify(schema(), null, 2) })
  return {
    name: 'obpal-catalogue-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const body = req.url ? files()[req.url.split('?')[0]] : undefined
        if (!body) return next()
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(body)
      })
    },
    generateBundle() {
      if (this.environment?.name !== 'client') return
      for (const [name, source] of Object.entries(files())) this.emitFile({ type: 'asset', fileName: name.slice(1), source })
    },
  }
}

/** ob.Pal Link's version where a page says %LINK_VERSION% (the Link page), from extension/package.json: it can't go stale. */
function linkVersion(): Plugin {
  const version = (JSON.parse(readFileSync(join(root, 'extension/package.json'), 'utf8')) as { version: string }).version
  return { name: 'obpal-link-version', transformIndexHtml: (html) => html.replaceAll('%LINK_VERSION%', version) }
}

/**
 * Link previews on every page (scripts/lib/preview.mjs): Open Graph and Twitter tags made from the page's own title
 * and description (the home page's for a page without one), its address, and the preview image, public/og.png.
 */
function pagePreviews(): Plugin {
  const fallback = () => pageWords(readFileSync(join(root, 'index.html'), 'utf8')).description
  return { name: 'obpal-page-previews', transformIndexHtml: (html, ctx) => ({ html, tags: previewTags(html, ctx.path, { fallback: fallback(), origin: PUBLIC_ORIGIN }) }) }
}

/** Crawlable page text and metadata, built from the same sim catalogue the browser uses. */
function searchPages(): Plugin {
  const controllerName = (id: string) => CONTROLLERS[id as keyof typeof CONTROLLERS].name
  const gitDate = (path: string) => {
    const source = path === '/' ? 'index.html' : path.startsWith('/sim/') ? 'src/sim' : `${path.slice(1)}index.html`
    try { return execFileSync('git', ['log', '-1', '--format=%cs', '--', source], { cwd: root, encoding: 'utf8' }).trim() || '2026-09-28' }
    catch { return '2026-09-28' }
  }
  return {
    name: 'obpal-search-pages',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const path = ctx.path.replace(/index\.html$/, '')
        const indexable = INDEXABLE_PAGES.includes(path)
        const canonical = `<link rel="canonical" href="${new URL(path, PUBLIC_ORIGIN)}" />`
        const noindex = indexable ? '' : '<meta name="robots" content="noindex, follow" />'
        const schema = indexable ? `<script type="application/ld+json">${jsonLd(structuredData(path, SIMS))}</script>` : ''
        let out = html.replace('</head>', `    ${canonical}\n    ${noindex}\n    ${schema}\n  </head>`)
        if (path === '/sim/') out = out.replace('<section class="sims-grid"', `${catalogueMarkup(SIMS, controllerName)}\n      <section class="sims-grid"`)
        if (path === '/') out = out.replace('<section class="closer"', `${faqMarkup()}\n      <section class="closer"`)
        return out
      },
    },
    writeBundle(options, bundle) {
      if (this.environment?.name !== 'client' || !options.dir) return
      const template = bundle['sim/device/index.html']
      if (!template || template.type !== 'asset') throw new Error('The device page was not built')
      const deviceIds = new Set(DEVICE_IDS)
      for (const card of SIMS.filter(c => deviceIds.has(c.id))) {
        const target = join(options.dir, 'sim', card.id, 'index.html')
        mkdirSync(join(options.dir, 'sim', card.id), { recursive: true })
        writeFileSync(target, deviceMarkup(String(template.source), card, controllerName, (DEVICE_MODELS[card.id] ?? []).map(prototypeUrl)))
      }
      writeFileSync(join(options.dir, 'robots.txt'), robotsTxt())
      writeFileSync(join(options.dir, 'sitemap.xml'), sitemapXml(SIMS, gitDate))
    },
  }
}

export default defineConfig({
  plugins: [markupBuild(root), cloudflare(), deployRecovery(), controllerServiceWorker(), embedScript(), catalogueFiles(), linkVersion(), pagePreviews(), searchPages(), simEarly(), pagePolicy()],
  server: { port: 5175, strictPort: true },
  environments: {
    client: {
      build: {
        // Controller floor from PLAN.md: Safari 15, Chromium 95, Firefox 115.
        target: ['safari15', 'chrome95', 'firefox115', 'edge95'],
        rollupOptions: {
          input: { index: 'index.html', controller: 'p/index.html', viewer: 'view/index.html', sponsor: 'sponsor/index.html', donate: 'donate/index.html', link: 'link/index.html', privacy: 'privacy/index.html', sims: 'sim/index.html', simArm: 'sim/arm/index.html', simArena: 'sim/arena/index.html', simDevice: 'sim/device/index.html', simEarly: 'src/sim/kit/early.ts', catalogue: 'catalogue/index.html', embed: 'embed/index.html', buttons: 'buttons/index.html' },
        },
      },
    },
  },
})
