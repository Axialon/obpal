/**
 * Package extension/dist for release: extension/release/obpal-link-<version>.zip, plus obpal-link.zip (same bytes)
 * so a "latest" download link never changes. manifest.json sits at the zip's root, as the Chrome Web Store and
 * "Load unpacked" (after unzipping) both expect.
 *
 * Usage: pnpm run pack:extension (builds first), or node extension/scripts/pack.mjs after a build.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { files, zip } from './zip.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(root, 'dist')
const out = resolve(root, 'release')

const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'))
const bytes = await zip(await files(dist), dist)
await mkdir(out, { recursive: true })
const versioned = join(out, `obpal-link-${manifest.version}.zip`)
await writeFile(versioned, bytes)
await writeFile(join(out, 'obpal-link.zip'), bytes)
console.log(`ob.Pal Link ${manifest.version}: ${versioned} (${(bytes.length / 1024).toFixed(1)} KB)`)
