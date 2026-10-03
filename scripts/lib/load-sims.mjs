/** Load the browser catalogue at build time without pulling its optional previews into Vite's config bundle. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadSims(root, build) {
  const dir = await mkdtemp(join(tmpdir(), 'obpal-seo-'))
  const outfile = join(dir, 'catalogue.mjs')
  try {
    await build({ configFile: false, root, publicDir: false, logLevel: 'silent',
      plugins: [{ name: 'seo-preview-stubs', resolveId(id) {
        if (/(?:\.view|arm-preview|scene-previews)$/.test(id)) return '\0seo-preview-stub'
        if (id === 'virtual:obpal-templates') return '\0seo-templates-stub'
      }, load(id) {
        if (id === '\0seo-preview-stub') return 'export const preview = () => null'
        if (id === '\0seo-templates-stub') return 'export default []'
      } }],
      resolve: { alias: { '@obpal/core': join(root, 'packages/core/src/index.ts') } },
      build: { outDir: dir, emptyOutDir: false, copyPublicDir: false, ssr: join(root, 'src/sim/catalogue.ts'),
        rollupOptions: { output: { entryFileNames: 'catalogue.mjs' } } },
      // The octopus's pure logic uses three.js maths; bundle it so the temporary module needs no node_modules.
      ssr: { noExternal: ['@obpal/core', 'three'] },
    })
    const { SIMS, DEVICE_IDS } = await import(pathToFileURL(outfile).href)
    return { SIMS, DEVICE_IDS }
  } finally {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Temporary catalogue path escaped the temp directory')
    await rm(dir, { recursive: true, force: true })
  }
}
