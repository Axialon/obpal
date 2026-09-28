/** Notify IndexNow after a deploy. Pass --since <deployed sha>, explicit paths, or both. */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INDEXABLE_PAGES } from './lib/seo.mjs'
import { SITE } from './lib/preview.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2).filter(a => a !== '--')
const dryRun = args.includes('--dry-run')
const sinceAt = args.indexOf('--since')
if (sinceAt >= 0 && !args[sinceAt + 1]) throw new Error('Pass a commit after --since')
const since = sinceAt >= 0 ? args.splice(sinceAt, 2)[1] : args.some(a => a !== '--dry-run') ? null : 'HEAD^'
const paths = args.filter(a => a !== '--dry-run')
const keyFile = readdirSync(join(root, 'public')).find(f => /^[a-f0-9]{32}\.txt$/.test(f))
if (!keyFile) throw new Error('The IndexNow key file is missing')
const key = readFileSync(join(root, 'public', keyFile), 'utf8').trim()
if (`${key}.txt` !== keyFile) throw new Error('The IndexNow key file does not match its name')

const sitemap = readFileSync(join(root, 'dist', 'client', 'sitemap.xml'), 'utf8')
const indexed = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname))
const changed = since ? execFileSync('git', ['diff', '--name-only', `${since}..HEAD`], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean) : []
const notify = new Set(paths.map(p => new URL(p, SITE).pathname))
const all = () => indexed.forEach(p => notify.add(p))
for (const file of changed) {
  if (/^(vite\.config\.ts|scripts\/lib\/(seo|preview)\.mjs|src\/sim\/(catalogue|arms)\.ts|src\/sim\/devices\/registry\.ts|spec\/MESSAGING\.md)$/.test(file)) { all(); continue }
  const page = /^(.+\/)?index\.html$/.exec(file)
  if (page) { notify.add(page[1] ? `/${page[1]}` : '/'); continue }
  const device = /^src\/sim\/devices\/([a-z0-9-]+)\./.exec(file)
  if (device) { notify.add('/sim/'); notify.add(`/sim/${device[1]}/`); continue }
  if (file.startsWith('src/sim/')) { notify.add('/sim/'); continue }
  if (file.startsWith('src/landing/')) { notify.add('/'); continue }
  if (file.startsWith('src/viewer/')) { notify.add('/view/'); continue }
  if (file.startsWith('public/') || file.startsWith('src/styles/')) all()
}
const urlList = [...notify].filter(p => indexed.has(p) && (INDEXABLE_PAGES.includes(p) || p.startsWith('/sim/'))).map(p => new URL(p, SITE).href)
if (!urlList.length) { console.log('No changed indexable URLs.'); process.exit(0) }
if (dryRun) { console.log(urlList.join('\n')); process.exit(0) }

const keyLocation = `${SITE}/${keyFile}`
const liveKey = await fetch(keyLocation)
if (!liveKey.ok || (await liveKey.text()).trim() !== key) throw new Error('The IndexNow key file is not live yet; deploy before notifying')
const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: new URL(SITE).host, key, keyLocation, urlList }),
})
if (!response.ok) throw new Error(`IndexNow returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
console.log(`IndexNow accepted ${urlList.length} URLs (${response.status}).`)
