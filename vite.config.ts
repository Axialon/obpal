import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { checkProfile, CONTROLLER_ID, CONTROLLER_IDS, CONTROLLERS, MOTION_UTILITIES, PROFILE_IDS, PROFILE_LIMITS, PROFILES, ROUTES, utilityKey } from './packages/core/src/catalogue'
import { Mode } from './packages/core/src/state'
import { BRIDGE_ROWS, EMBED, REPO, SYSTEM_ROWS, UTILITY_ROWS } from './src/catalogue/data'

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
 * /catalogue.json (utilities, routes, built-in and community profiles, systems, bridges) and /profile.schema.json.
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
    description: `A named set of motion settings a phone applies (CATALOGUE §3). Check one with checkProfile() in @obpal/core, then add it as catalogue/profiles/<id>.json in ${REPO}.`,
    type: 'object',
    required: ['id', 'name', 'for', 'on', 'aim', 'steer', 'point'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: PROFILE_LIMITS.id.source, not: { enum: [...PROFILE_IDS] }, description: 'New, lowercase, and the file name' },
      name: { type: 'string', minLength: 1, maxLength: PROFILE_LIMITS.name },
      for: { type: 'string', minLength: 1, maxLength: PROFILE_LIMITS.for, description: 'What it is for, one line' },
      on: { type: 'array', uniqueItems: true, items: { enum: [...MOTION_UTILITIES] }, description: 'Utilities it switches on when it applies' },
      ...Object.fromEntries(MOTION_UTILITIES.map((u) => [utilityKey(u), settings(ROUTES[u])])),
    },
  })
  const modeName = new Map(Object.entries(Mode).map(([name, m]) => [m, name]))
  const catalogue = () => ({
    name: 'ob.Pal control catalogue',
    about: 'Everything an ob.Pal phone can drive, and how: utilities, the controllers built from them, the routes motion takes, profiles, control systems and bridges, and the embed that puts ob.Pal on any page.',
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
    limits: { gain: PROFILE_LIMITS.gain, curve: PROFILE_LIMITS.curve, deadzone: PROFILE_LIMITS.deadzone, id: PROFILE_LIMITS.id.source, name: PROFILE_LIMITS.name, for: PROFILE_LIMITS.for },
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

export default defineConfig({
  plugins: [cloudflare(), controllerServiceWorker(), embedScript(), catalogueFiles(), linkVersion()],
  server: { port: 5175, strictPort: true },
  environments: {
    client: {
      build: {
        // Controller floor from PLAN.md: Safari 15, Chromium 95, Firefox 115.
        target: ['safari15', 'chrome95', 'firefox115', 'edge95'],
        rollupOptions: {
          input: { index: 'index.html', controller: 'p/index.html', viewer: 'view/index.html', sponsor: 'sponsor/index.html', donate: 'donate/index.html', link: 'link/index.html', privacy: 'privacy/index.html', sims: 'sim/index.html', simArm: 'sim/arm/index.html', simArena: 'sim/arena/index.html', catalogue: 'catalogue/index.html', embed: 'embed/index.html' },
        },
      },
    },
  },
})
