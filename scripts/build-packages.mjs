/**
 * Build @obpal/core and @obpal/host for npm, into packages/<name>/dist: ES modules and type declarations from the same
 * sources the site uses (packages/<name>/tsconfig.build.json), with `.js` on relative imports so Node and every bundler
 * resolve them, and the licence beside them. The workspace keeps importing the TypeScript sources; each package's
 * publishConfig points the published package at dist. Core builds first: host's declarations import core's.
 *   node scripts/build-packages.mjs          both
 *   node scripts/build-packages.mjs host     one (its dependencies must be built)
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const ORDER = ['core', 'host']
const only = process.argv.slice(2)

/** Every file under a folder. */
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

/** `./x` → `./x.js` in static and dynamic imports and re-exports; specifiers with an extension are left alone. */
function withExtensions(code) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]+?)\2/g, (m, lead, q, spec) =>
    /\.[cm]?js$|\.json$/.test(spec) ? m : `${lead}${q}${spec}.js${q}`)
}

for (const name of ORDER.filter((n) => !only.length || only.includes(n))) {
  const dir = join(root, 'packages', name)
  const dist = join(dir, 'dist')
  rmSync(dist, { recursive: true, force: true })
  execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.build.json')], { stdio: 'inherit' })
  const files = walk(dist).filter((f) => /\.(js|d\.ts)$/.test(f))
  for (const f of files) writeFileSync(f, withExtensions(readFileSync(f, 'utf8')))
  copyFileSync(join(root, 'LICENSE'), join(dist, 'LICENSE'))
  console.log(`@obpal/${name}: ${files.length} files in packages/${name}/dist`)
}
