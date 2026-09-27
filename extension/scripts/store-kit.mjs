#!/usr/bin/env node
// The Chrome Web Store paste kit: every field in extension/store/listing.md with a Copy button, in the dashboard's
// order, and a Copy path button for each file to upload. The dashboard can't be driven for you (Chrome keeps
// extensions off the store's pages, and Google refuses sign-in in embedded browsers), so this makes the clicks quick.
// Writes extension/release/store-kit.html (ignored by git). It never reads the key or the first-upload zip.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const store = join(root, 'extension', 'store')
const version = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), 'utf8')).version
const md = readFileSync(join(store, 'listing.md'), 'utf8').replace(/\r\n/g, '\n')

/** listing.md by its "## " tabs: each ```text block, named by the line before it, and each "- Name: `value`". */
const tabs = []
let tab = null, name = '', inBlock = false, lines = []
const clean = (s) => s.replace(/^[-*\s]+/, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/[:.]\s*$/, '').trim()
for (const line of md.split('\n')) {
  if (inBlock) {
    if (line.startsWith('```')) { tab.fields.push({ name, text: lines.join('\n') }); inBlock = false; lines = [] }
    else lines.push(line)
    continue
  }
  if (line.startsWith('## ')) { tab = { title: line.slice(3).trim(), fields: [] }; tabs.push(tab); name = tab.title; continue }
  if (!tab) continue
  if (line.startsWith('```text')) { inBlock = true; continue }
  const value = line.match(/^- ([^:`]+): `([^`]+)`/) ?? line.match(/^\*\*([^*:]+):\*\* `([^`]+)`/)
  if (value) { tab.fields.push({ name: value[1].trim(), text: value[2] }); continue }
  if (line.trim() && !line.startsWith('|')) name = clean(line).replace(/\s*\(.*\)$/, '')
}

// What to tick and pick where there's nothing to paste (the owner's choices, 2026-09-27; UPLOAD.md's decisions).
const choices = {
  'Store listing tab': ['Category: Tools', 'Language: English', 'Official URL: leave empty', 'Mature content: No', 'Upload the icon, the five screenshots and the two promo tiles (below), then Save draft'],
  'Privacy practices tab': ['Remote code: No, then paste its text', 'Data usage: tick none of the data types', 'Tick all three certifications', 'Then Save draft'],
  'Distribution tab': ['Visibility: Public', 'Regions: all regions', 'No in-app purchases', 'Then Save draft'],
}
/** The dashboard's "Unable to publish" list, in its words, and the tab below that fixes each. */
const blockers = [
  ['Store listing tab', 'The detailed description, a category, the language, the icon image, and at least one screenshot'],
  ['Privacy practices tab', 'The single purpose; a justification for activeTab, the host permission, nativeMessaging, notifications, offscreen, scripting and storage; the remote code answer; and the data usage certification'],
]
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const art = ['icon-128.png', ...[1, 2, 3, 4, 5].map((n) => `screenshot-${n}.png`), 'tile-440x280.png', 'marquee-1400x560.png']
const files = [
  { name: `Package, an update to the listed item (Package → Upload new package)`, path: join(root, 'extension', 'release', `obpal-link-${version}-store.zip`) },
  { name: 'Package, only when creating the item (New item): it carries the key, so pick it yourself', path: join(homedir(), '.obpal-keys', 'store', `obpal-link-${version}-store-first-upload.zip`) },
  ...art.map((f) => ({ name: f.startsWith('icon') ? 'Store icon' : f.startsWith('screenshot') ? `Screenshot ${f.match(/\d/)[0]}` : f.startsWith('tile') ? 'Small promo tile' : 'Marquee promo tile', path: join(store, f) })),
]

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const copyable = (label, text, meta = '') => `<div class="field"><div class="head"><b>${esc(label)}</b>${meta}<button type="button" data-copy="${esc(text)}">Copy</button></div><pre>${esc(text)}</pre></div>`
const fileRow = (f) => `<div class="file"><span>${esc(f.name)}<code>${esc(f.path)}</code></span><button type="button" data-copy="${esc(f.path)}">Copy path</button></div>`
const count = (f) => (/summary/i.test(f.name) ? ` <span class="n">${f.text.length} of 132</span>` : /description/i.test(f.name) ? ` <span class="n">${f.text.length} of 16,000</span>` : '')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store kit</title>
<style>
:root { color-scheme: dark; --bg: #0d0e0b; --card: #16181299; --line: #2a2d24; --text: #eef2e6; --dim: #a3a898; --lime: #c4f23c }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --bg: #f5f6f1; --card: #ffffffcc; --line: #d9dccf; --text: #16180f; --dim: #5d6152; --lime: #5d8a00 } }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px }
h1 { font-size: 22px; margin: 0 0 4px } h2 { font-size: 17px; margin: 28px 0 10px; color: var(--lime) }
p.lead { color: var(--dim); margin: 0 0 8px }
.field, .file { border: 1px solid var(--line); background: var(--card); border-radius: 12px; padding: 10px 12px; margin: 8px 0 }
.head, .file { display: flex; gap: 10px; align-items: center; flex-wrap: wrap }
.head b { flex: 1 } .n { color: var(--dim); font-size: 13px }
.file span { flex: 1; min-width: 200px } .file code { display: block; color: var(--dim); font-size: 12px; word-break: break-all }
pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; font: 13px/1.45 ui-monospace, monospace; color: var(--dim); max-height: 220px; overflow: auto }
ul.ticks { margin: 4px 0 0; padding-left: 20px } ul.ticks li::marker { content: '✓  '; color: var(--lime) }
button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 6px 14px; background: var(--lime); color: #111; cursor: pointer }
button.done { background: transparent; color: var(--lime); box-shadow: inset 0 0 0 1.5px var(--lime) }
</style></head>
<body><main>
<h1>ob.Pal Link ${esc(version)} on the Chrome Web Store</h1>
<p class="lead">Copy each field into the <a href="https://chrome.google.com/webstore/devconsole" style="color:var(--lime)">Developer Dashboard</a>, in this order. For a file, press Copy path, click the dashboard's upload button, paste into the dialog's File name box and press Enter.</p>
<p class="lead">Once, on the Account page: verify the contact email, set the publisher name, and answer the trader question: <b>non-trader</b>.</p>
<h2>What the dashboard says is missing</h2>
<ul class="ticks">${blockers.map(([tab, what]) => `<li><a href="#${slug(tab)}" style="color:var(--lime)">${esc(tab)}</a>: ${esc(what)}.</li>`).join('')}<li>Save draft on each tab before moving to the next; the list only clears for saved fields.</li></ul>
<h2>Package</h2>
${files.slice(0, 2).map(fileRow).join('\n')}
${tabs.filter((t) => t.fields.length || choices[t.title]).filter((t) => t.title !== 'Package').map((t) => `<h2 id="${slug(t.title)}">${esc(t.title)}</h2>
${choices[t.title] ? `<ul class="ticks">${choices[t.title].map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
${t.fields.map((f) => copyable(f.name, f.text, count(f))).join('\n')}
${t.title === 'Store listing tab' ? files.slice(2).map(fileRow).join('\n') : ''}`).join('\n')}
<h2>Then</h2>
<ul class="ticks"><li>Submit for review. Choose to publish by hand after approval if the site should link to the listing the same day.</li><li>Send Claude the listing's address.</li></ul>
</main>
<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-copy]')
  if (!b) return
  const text = b.dataset.copy
  try { await navigator.clipboard.writeText(text) } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove()
  }
  const was = b.textContent; b.textContent = 'Copied'; b.classList.add('done')
  setTimeout(() => { b.textContent = was }, 1600)
})
</script>
</body></html>
`

const out = join(root, 'extension', 'release', 'store-kit.html')
mkdirSync(join(root, 'extension', 'release'), { recursive: true })
writeFileSync(out, html)
console.log(`Store kit for ${version}: ${out}`)
console.log(`  open ${pathToFileURL(out).href}`)
