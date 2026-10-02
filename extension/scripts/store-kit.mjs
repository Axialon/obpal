#!/usr/bin/env node
/** Dashboard fields for the existing item, compared with submitted 1.6.2. This kit never consults private keys. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseListing, compareFields, changedParagraphs } from './store-fields.mjs'

export function renderStoreKit(root) {
  const store = join(root, 'extension', 'store')
  const baseline = 'a4f0ff0'
  const oldFile = file => execFileSync('git', ['show', `${baseline}:extension/store/${file}`], { cwd: root, maxBuffer: 20e6 })
  const version = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), 'utf8')).version
  const tabs = compareFields(parseListing(readFileSync(join(store, 'listing.md'), 'utf8')), parseListing(oldFile('listing.md').toString('utf8')))
  const status = JSON.parse(readFileSync(join(store, 'status.json'), 'utf8'))
  const art = ['icon-128.png', ...[1, 2, 3, 4, 5].map(n => `screenshot-${n}.png`), 'tile-440x280.png', 'marquee-1400x560.png']
  const images = art.map(file => ({
    name: file.startsWith('icon') ? 'Store icon' : file.startsWith('screenshot') ? `Screenshot ${file.match(/\d/)[0]}` : file.startsWith('tile') ? 'Small promo tile' : 'Marquee promo tile',
    path: `../store/${file}`, file, changed: !readFileSync(join(store, file)).equals(oldFile(file)),
    why: !file.startsWith('screenshot') ? 'matches the ob.Pal logo used everywhere else' : 'current popup, seal surface and brand design',
  }))
  const packageFile = join(root, 'extension', 'release', `obpal-link-${version}-store.zip`)
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const marker = changed => `<span class="mark ${changed ? 'changed' : ''}">${changed ? 'CHANGED (update this)' : 'unchanged (leave as is)'}</span>`
  const button = (label, value) => `<button type="button" data-copy="${esc(value)}">${label}</button>`
  const count = f => /summary/i.test(f.name) ? `${f.text.length} / 132` : /description/i.test(f.name) ? `${f.text.length} / 16,000` : /test instructions/i.test(f.name) ? `${f.text.length} / 500` : ''
  function field(f) {
    const diff = changedParagraphs(f.before, f.text)
    return `<article class="field" id="${slug(f.name)}"><div class="head"><b>${esc(f.name)}</b>${marker(f.changed)}<small>${count(f)}</small>${button('Copy', f.text)}</div>
    ${f.changed ? `<details open><summary>Before → after (changed paragraphs only)</summary><div class="compare"><div><b>Before · live 1.6.2</b><pre>${esc(diff.before || '(empty)')}</pre></div><div><b>After · ${esc(version)}</b><pre>${esc(diff.after || '(empty)')}</pre></div></div></details>` : ''}
    <details${f.changed ? ' open' : ''}><summary>Full field to paste</summary><pre>${esc(f.text)}</pre></details></article>`
  }
  const fileRow = f => `<article class="field"><div class="head"><b>${esc(f.name)}</b>${marker(f.changed)}${button('Copy path', f.path)}</div><code>${esc(f.path)}</code>${f.why && f.changed ? `<p>${esc(f.why)}</p>` : ''}${f.file ? `<img class="preview" src="${esc(f.path)}" alt="${esc(f.name)} preview">` : ''}</article>`
  const changedFields = tabs.flatMap(t => t.fields.filter(f => f.changed).map(f => ({ tab: t.title, name: f.name })))
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ob.Pal Link ${esc(version)} · store update kit</title><style>
  :root{color-scheme:dark;--bg:#0d0e0b;--card:#161812;--line:#33362c;--text:#eef2e6;--dim:#b0b5a5;--lime:#c6ff34}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 8px}h2{font-size:20px;margin:28px 0 12px}p{color:var(--dim)}a{color:var(--lime)}.field,.checklist{border:1px solid var(--line);background:var(--card);border-radius:14px;padding:14px;margin:10px 0}.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.head>b{flex:1;min-width:160px}.mark{font-size:12px;color:var(--dim)}.changed{color:var(--lime);font-weight:700}.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace;color:var(--dim);max-height:280px;overflow:auto}code{display:block;overflow-wrap:anywhere;font-size:12px;color:var(--dim);margin-top:8px}button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:999px;background:var(--lime);color:#10110b;cursor:pointer}button:focus-visible,summary:focus-visible{outline:2px solid var(--lime);outline-offset:4px}summary{cursor:pointer;margin-top:12px}small{color:var(--dim)}.preview{display:block;max-width:100%;max-height:180px;margin-top:12px}.checklist h2{margin:0}.checks{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;padding:0;list-style:none}.checks input{accent-color:var(--lime)}@media(max-width:600px){.compare,.checks{grid-template-columns:1fr}h1{font-size:23px}}
  </style></head><body><main>
  <h1>ob.Pal Link ${esc(version)} · store update kit</h1>
  <section class="checklist"><h2>What to update</h2><p>Compared with live 1.6.2, submitted at <code style="display:inline">${baseline}</code>. Update only the marked fields and files.</p>
  <ul class="checks"><li><label><input type="checkbox"> Package → Upload new package (${esc(version)}, no key)</label></li>
  ${changedFields.map(f => `<li><label><input type="checkbox"> ${esc(f.tab.replace(/ tab.*/, ''))}: <a href="#${slug(f.name)}">${esc(f.name)}</a></label></li>`).join('')}
  <li><label><input type="checkbox"> Replace ${images.filter(i => i.changed).map(i => esc(i.name)).join(', ') || 'no images'}</label></li>
  <li><label><input type="checkbox"> Save draft on each edited tab</label></li></ul>
  <p>Leave every “unchanged” field and image as it is. Remote code: No; data usage: Location, Web history and User activity; all three certifications remain checked. Keep the existing distribution settings.</p></section>
  <h2>Where it stands</h2><p>${esc(status.state)} · ${esc(status.updated)}</p><ul>${status.done.map(s => `<li>${esc(s)}</li>`).join('')}</ul><ol>${status.next.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
  <h2>Package</h2>${fileRow({ name: `Package ${version} (existing item)`, path: `obpal-link-${version}-store.zip`, changed: true })}
  ${!existsSync(packageFile) ? '<p>Build the package with pnpm run store:extension before upload.</p>' : ''}
  ${tabs.filter(t => t.fields.length).map(t => `<h2>${esc(t.title)}</h2>${t.fields.map(field).join('')}${t.title === 'Store listing tab' ? images.map(fileRow).join('') : ''}`).join('')}
  <p>The coordinator uploads and submits the existing item through the <a href="https://chrome.google.com/webstore/devconsole">Developer Dashboard</a>.</p>
  </main><script>
  document.addEventListener('click',async e=>{const b=e.target.closest('button[data-copy]');if(!b)return;const label=b.textContent;try{await navigator.clipboard.writeText(b.dataset.copy)}catch{const t=document.createElement('textarea');t.value=b.dataset.copy;document.body.append(t);t.select();document.execCommand('copy');t.remove()}b.textContent='Copied';setTimeout(()=>{b.textContent=label},1600)})
  </script></body></html>`
  return { html, version, changedFields: changedFields.length, changedImages: images.filter(i => i.changed).length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '../..')
  const result = renderStoreKit(root)
  const out = join(root, 'extension', 'release', 'store-kit.html')
  mkdirSync(join(root, 'extension', 'release'), { recursive: true })
  writeFileSync(out, result.html)
  console.log(`Store kit for ${result.version}: ${out}`)
  console.log(`Baseline a4f0ff0: ${result.changedFields} changed text fields; ${result.changedImages} changed images`)
  console.log(`  open ${pathToFileURL(out).href}`)
}
