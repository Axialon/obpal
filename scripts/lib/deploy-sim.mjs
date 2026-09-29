/**
 * A pretend next deploy for the browser tests: this checkout's build with every hashed file under a new name, and its
 * pages and chunks pointing at the new names, as after a rebuild that changed everything. Nothing is written: a test
 * serves it from memory (page.route) as the site after the deploy, and the real files are the build before it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listFiles } from './keep-assets.mjs'

const TYPES = { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8', mp3: 'audio/mpeg', webm: 'video/webm' }
const base = (file) => file.slice(file.lastIndexOf('/') + 1)
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param {string} dir the built site (dist/client)
 * @returns {Promise<{ files: Map<string, { body: string | Buffer; type: string }>; gone: Set<string> }>}
 *   files: what the next build serves, by path; gone: the paths of this build's hashed files, which the deploy removes
 */
export async function nextBuild(dir) {
  const assets = listFiles(join(dir, 'assets'))
  const renamed = new Map(assets.map((f) => [base(f), base(f).replace(/(\.[a-z0-9]+)$/, 'x$1')]))
  // Longest first, so that no name is read as the start of another.
  const names = new RegExp([...renamed.keys()].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g')
  const rewrite = (text) => text.replace(names, (name) => renamed.get(name))
  const files = new Map()
  const gone = new Set()
  for (const file of assets) {
    const type = TYPES[file.split('.').pop()] ?? 'application/octet-stream'
    const bytes = await readFile(join(dir, 'assets', file))
    const text = type.startsWith('text/')
    files.set(`/assets/${file.slice(0, file.length - base(file).length)}${renamed.get(base(file))}`, { body: text ? rewrite(bytes.toString('utf8')) : bytes, type })
    gone.add(`/assets/${file}`)
  }
  for (const file of listFiles(dir).filter((f) => f.endsWith('.html'))) {
    const page = { body: rewrite(await readFile(join(dir, file), 'utf8')), type: TYPES.html }
    files.set(`/${file}`, page)
    if (file.endsWith('index.html')) files.set(`/${file.slice(0, -'index.html'.length)}`, page)
  }
  return { files, gone }
}
