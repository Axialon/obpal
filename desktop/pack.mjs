/**
 * Package ob.Pal Desktop for release: desktop/release/obpal-desktop-windows-x64.zip, one `obpal-desktop/` folder
 * with the helper, install.cmd, uninstall.cmd, README.txt (package/, with the version filled in) and LICENSE.txt.
 * The Link release carries it beside obpal-link.zip; the install guide downloads it from the latest release.
 *
 * Usage: cargo build --release (in desktop/), then node desktop/pack.mjs.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zip } from '../extension/scripts/zip.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const exe = resolve(here, 'target/release/obpal-desktop.exe')
if (!existsSync(exe)) throw new Error(`no ${exe}: run cargo build --release in desktop/ first`)
const version = /^version\s*=\s*"([^"]+)"/m.exec(await readFile(resolve(here, 'Cargo.toml'), 'utf8'))[1]
// Windows text: CRLF line ends, which batch files need and every editor reads.
const crlf = (s) => s.replace(/\r?\n/g, '\r\n')
const text = async (p) => crlf(await readFile(p, 'utf8'))
// The title carries the version, and its underline follows its length.
const readme = (await text(resolve(here, 'package/README.txt')))
  .replace('{version}', version.replace(/\.0$/, ''))
  .replace(/^(.*)\r\n=+\r\n/, (_, title) => `${title}\r\n${'='.repeat(title.length)}\r\n`)

const bytes = await zip([], here, {
  'obpal-desktop/obpal-desktop.exe': await readFile(exe),
  'obpal-desktop/install.cmd': await text(resolve(here, 'package/install.cmd')),
  'obpal-desktop/uninstall.cmd': await text(resolve(here, 'package/uninstall.cmd')),
  'obpal-desktop/README.txt': readme,
  'obpal-desktop/LICENSE.txt': await text(resolve(here, '../LICENSE')),
})
const out = resolve(here, 'release')
await mkdir(out, { recursive: true })
const path = join(out, 'obpal-desktop-windows-x64.zip')
await writeFile(path, bytes)
console.log(`ob.Pal Desktop ${version}: ${path} (${(bytes.length / 1024).toFixed(1)} KB)`)
