#!/usr/bin/env node
/** The generated dashboard kit is the only file that stores absolute upload paths. */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedParagraphs } from './store-fields.mjs'
import { readJson, storeStatus, writeJson } from './store-manager.mjs'
import { git } from './store-source.mjs'
import { parseListing } from './store-fields.mjs'
import { checkStoreCopy } from './store-copy.mjs'
import { ITEM_ID, validateLiveLinks } from './store-links.mjs'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const marker = changed => '<span class="mark ' + (changed ? 'changed' : '') + '">' + (changed ? 'CHANGED' : 'unchanged') + '</span>'
const button = (label, value) => '<button type="button" data-copy="' + esc(value) + '">' + label + '</button>'

export async function renderStoreKit(root, options = {}) {
  // The kit is what gets uploaded: its art, listing and zip are always held to their receipts.
  const info = await storeStatus(root, undefined, { ...options, validateCurrent: true, strict: true })
  if (info.packageError) throw new Error(info.packageError)
  const { version, tabs, baseline, status, images, packageInfo } = info
  const consistency = (options.checkCopy ?? checkStoreCopy)(root, packageInfo.manifest)
  const links = await (options.checkLinks ?? validateLiveLinks)()
  const published = readJson(join(root, 'extension/store/submissions.json')).entries.findLast(entry => entry.state === 'published')
  const description = listing => parseListing(listing).flatMap(tab => tab.fields).find(field => field.name === 'Description')?.text ?? ''
  const releaseChanges = changedParagraphs(published ? description(git(root, ['show', `${published.commit}:extension/store/listing.md`])) : '', description(readFileSync(join(root, 'extension/store/listing.md'), 'utf8'))).after
  const fileRow = f => '<article><div class="head"><b>' + esc(f.file) + '</b>' + marker(f.changed) + '<a download href="' + (f.width ? '../store/' : './') + esc(f.file) + '">Download</a>' + button('Copy path', f.path) + '</div><code>' + esc(f.path) + '</code><p>' + f.bytes.toLocaleString('en') + ' bytes | SHA-256 <code>' + f.sha256 + '</code> | ' + (f.width ? f.width + ' x ' + f.height + ' px | PNG' : 'ZIP | pixel dimensions: not applicable') + '</p>' + (f.width ? '<img class="preview" src="../store/' + esc(f.file) + '" alt="' + esc(f.file) + ' preview">' : '') + '</article>'
  const field = f => {
    const diff = changedParagraphs(f.before, f.text)
    return '<article><div class="head"><b>' + esc(f.name) + '</b>' + marker(f.changed) + button('Copy', f.text) + '</div>' + (f.changed ? '<details open><summary>Changed paragraphs</summary><div class="compare"><div><b>Before | submitted ' + esc(baseline?.version ?? 'none') + '</b><pre>' + esc(diff.before || '(empty)') + '</pre></div><div><b>After | ' + esc(version) + '</b><pre>' + esc(diff.after || '(empty)') + '</pre></div></div></details>' : '') + '<details' + (f.changed ? ' open' : '') + '><summary>Full field to paste</summary><pre>' + esc(f.text) + '</pre></details></article>'
  }
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ob.Pal Link ' + esc(version) + ' | store update kit</title><style>' +
    ':root{color-scheme:dark;--bg:#0d0e0b;--card:#161812;--line:#33362c;--text:#eef2e6;--dim:#b0b5a5;--lime:#c6ff34}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 8px}h2{font-size:20px;margin:28px 0 12px}p{color:var(--dim)}a{color:var(--lime)}article,.checklist{border:1px solid var(--line);background:var(--card);border-radius:14px;padding:14px;margin:10px 0}.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.head>b{flex:1;min-width:160px}.mark{font-size:12px;color:var(--dim)}.changed{color:var(--lime);font-weight:700}.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace;color:var(--dim);max-height:280px;overflow:auto}code{display:block;overflow-wrap:anywhere;font-size:12px;color:var(--dim);margin-top:8px}button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:999px;background:var(--lime);color:#10110b;cursor:pointer}button:focus-visible,summary:focus-visible{outline:2px solid var(--lime);outline-offset:4px}summary{cursor:pointer;margin-top:12px}.preview{display:block;max-width:100%;max-height:180px;margin-top:12px}@media(max-width:600px){.compare{grid-template-columns:1fr}h1{font-size:23px}}' +
    '</style></head><body><main><h1>ob.Pal Link ' + esc(version) + ' | store update kit</h1><p>Item ID: <b>' + ITEM_ID + '</b></p><section class="checklist"><h2>What to update</h2><p>Compared with last submission ' + esc(baseline?.version ?? 'none') + ' at ' + esc(baseline?.commit.slice(0, 7) ?? 'none') + '. Upload the package and update each CHANGED field and image. Save drafts on each edited tab.</p><p>Published: ' + esc(status.published ?? 'none') + ' | Pending review: ' + esc(status.pending ?? 'none') + ' | Prepared: ' + esc(status.prepared ?? 'none') + '</p><p>Generated and links checked at ' + esc(new Date().toISOString()) + '. Regenerate before uploading, or use the live server.</p><ol><li>Package: upload the store zip to the existing item.</li><li>Store listing: paste changed fields and upload changed images; save draft.</li><li>Privacy practices: update justifications and disclosures; save draft.</li><li>Distribution: confirm availability; save draft.</li><li>Test instructions: paste reviewer notes; save draft.</li><li>Review and submit; afterwards run pnpm run store -- submitted ' + esc(version) + '.</li></ol></section><nav aria-label="Checked live destinations">' + links.map(link => '<p><a target="_blank" rel="noopener" href="' + esc(link.url) + '">' + esc(link.label) + '</a> — HTTP ' + link.status + '</p>').join('') + '</nav><details><summary>Copy consistency report</summary>' + consistency.map(text => '<p>' + esc(text) + '</p>').join('') + '</details><details><summary>Release changes: ' + esc(version) + ' since published ' + esc(published?.version ?? 'none') + '</summary><p>The dashboard summary remains the manifest description. These are changed description paragraphs against the published version.</p><pre>' + esc(releaseChanges || 'No description changes.') + '</pre></details><h2>1. Package</h2>' + fileRow({ ...packageInfo, changed: packageInfo.sha256 !== baseline?.zipSha256 }) + tabs.filter(t => t.fields.length).map((t, index) => '<h2>' + (index + 2) + '. ' + esc(t.title) + '</h2>' + t.fields.map(field).join('') + (t.title === 'Store listing tab' ? images.map(fileRow).join('') : '')).join('') + '<p>Record submission only after submitting this package in the dashboard: pnpm run store -- submitted ' + esc(version) + '.</p></main><script>' +
    'document.addEventListener("click",async e=>{const b=e.target.closest("button[data-copy]");if(!b)return;const label=b.textContent;try{await navigator.clipboard.writeText(b.dataset.copy)}catch{const t=document.createElement("textarea");t.value=b.dataset.copy;document.body.append(t);t.select();document.execCommand("copy");t.remove()}b.textContent="Copied";setTimeout(()=>{b.textContent=label},1600)})' + '</script></body></html>'
  return { html, version, status, links, consistency, changedFields: tabs.flatMap(t => t.fields).filter(f => f.changed).length, changedImages: images.filter(i => i.changed).length }
}

export async function writeStoreKit(root, options) {
  const out = join(root, 'extension/release/store-kit.html')
  try {
    const result = await renderStoreKit(root, { ...options, preparing: true })
    const statusFile = join(root, 'extension/store/status.json')
    if (readJson(statusFile).prepared !== result.status.prepared) writeJson(statusFile, { ...result.status, updated: new Date().toISOString().slice(0, 10) })
    mkdirSync(join(root, 'extension/release'), { recursive: true })
    writeFileSync(out, result.html)
    return { ...result, out }
  } catch (error) {
    rmSync(out, { force: true })
    throw error
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await writeStoreKit(resolve(import.meta.dirname, '../..')); console.log('Store kit ' + result.version + ': ' + result.out + '\n' + result.changedFields + ' changed fields; ' + result.changedImages + ' changed images') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
