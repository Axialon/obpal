/** Build a local evidence viewer from two contact runs. This is an explicit reporting command, not a test. */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const [beforePath, afterPath, destination, replayPath] = process.argv.slice(2)
if (!destination) throw new Error('Usage: node scripts/contact-report.mjs <before directory> <after directory> <output directory>')
const out = resolve(destination)
await mkdir(out, { recursive: true })
const read = async path => JSON.parse(await readFile(join(path, 'contacts.json'), 'utf8'))
const before = await read(beforePath), after = await read(afterPath)
const url = path => relative(out, resolve(path)).replaceAll('\\', '/')
const normal = name => name.replaceAll('/ankle/', '/')
const finite = n => typeof n === 'number' && Number.isFinite(n)
const fmt = n => finite(n) ? (Math.abs(n) < .0005 ? '0.000' : n.toFixed(3)) : 'not measured'
const csv = rows => rows.map(row => row.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'
async function videos(path, report) {
  const files = await Promise.all((await readdir(path)).filter(f => f.endsWith('.webm')).map(async f => ({ f, at: (await stat(join(path, f))).mtimeMs })))
  files.sort((a, b) => a.at - b.at)
  // Early baseline runs opened one recorded page per entry, in order. Modification times survive evidence copies.
  for (let i = 0; i < report.length; i++) if (!report[i].video && files.length === report.length) report[i].video = files[i].f
}
await videos(beforePath, before.report); await videos(afterPath, after.report)
const phases = ['placeholder-rest', 'placeholder-motion', 'swap', 'model-rest', 'model-motion', 'side-motion', 'floor-reach', 'floor-contact', 'block-reach', 'settle', 'limits', 'seabed-rest']
const entries = after.report.map(a => ({ id: a.id, before: before.report.find(b => b.id === a.id), after: a }))
if (replayPath) {
  const replay = await read(replayPath), files = await readdir(replayPath)
  for (const e of entries) { const media = replay.report.find(r => r.id === e.id); if (media) e.beforeMedia = { path: url(replayPath), video: media.video, files } }
}
const rows = [['sim', 'phase', 'part', 'before mode', 'before minimum mm', 'before maximum mm', 'before touch error mm', 'after mode', 'after minimum mm', 'after maximum mm', 'after touch error mm', 'after penetration mm', 'expected draft mm', 'after raw minimum mm', 'after raw maximum mm', 'after lowest vertex minimum mm', 'after lowest vertex maximum mm', 'shadow', 'frames']]
for (const e of entries) for (const phase of phases) {
  const bp = e.before?.rows.find(r => r.phase === phase)?.parts ?? [], ap = e.after.rows.find(r => r.phase === phase)?.parts ?? []
  for (const key of new Set([...bp, ...ap].map(p => normal(p.part)))) {
    const b = bp.find(p => normal(p.part) === key), a = ap.find(p => normal(p.part) === key)
    rows.push([e.id, phase, key, b?.mode, fmt(b?.minMm), fmt(b?.maxMm), fmt(b?.touchMaxMm), a?.mode, fmt(a?.minMm), fmt(a?.maxMm), fmt(a?.touchMaxMm), fmt(a?.penetrationMm), fmt(a?.expectedGapMm), fmt(a?.rawMinMm), fmt(a?.rawMaxMm), fmt(a?.lowestMinMm), fmt(a?.lowestMaxMm), a?.shadow, a?.frames])
  }
}
await writeFile(join(out, 'contact-table.csv'), csv(rows))
function bound(entry, motion) {
  const parts = entry?.rows.filter(r => motion ? /motion|reach|contact|swap|settle|limits/.test(r.phase) : /rest/.test(r.phase)).flatMap(r => r.parts) ?? []
  // The early boat baseline retained its signed water measurements as free contacts.
  // Compare those original measurements to the same 80 mm draft used by the corrected hull.
  const values = parts.map(p => entry.id === 'boat' && p.part === 'hull-keel' && p.mode === 'free' ? Math.max(Math.abs(p.minMm + 80), Math.abs(p.maxMm + 80)) : p.touchMaxMm).filter(finite)
  return values.length ? Math.max(...values) : null
}
function clearance(entry) {
  const values = entry?.rows.flatMap(r => r.parts.map(p => p.clearMinMm ?? (p.mode === 'clear' ? p.minMm : null))).filter(finite) ?? []
  return values.length ? Math.min(...values) : null
}
function contactBound(entry, motion) {
  const value = bound(entry, motion)
  if (finite(value)) return fmt(value)
  if (entry?.id === 'viewer') return 'N/A'
  return entry?.rows.some(r => r.parts.some(p => p.mode === 'clear')) ? 'clear only' : 'not measured'
}
const condensed = [['Sim', 'Before rest mm', 'Before motion mm', 'After rest mm', 'After motion mm', 'Before minimum clearance mm', 'After minimum clearance mm', 'Parts', 'Maximum penetration mm']]
for (const e of entries) condensed.push([e.id, contactBound(e.before, false), contactBound(e.before, true), contactBound(e.after, false), contactBound(e.after, true), fmt(clearance(e.before)), fmt(clearance(e.after)), new Set(e.after.rows.flatMap(r => r.parts.map(p => p.part))).size, fmt(Math.max(0, ...e.after.rows.flatMap(r => r.parts.map(p => p.penetrationMm ?? 0))))])
await writeFile(join(out, 'condensed.csv'), csv(condensed))
await writeFile(join(out, 'condensed.md'), condensed.map((r, i) => `| ${r.join(' | ')} |${i === 0 ? '\n|' + r.map(() => '---').join('|') + '|' : ''}`).join('\n') + '\n')
let clips = {}
try { clips = JSON.parse(await readFile(join(out, 'clips.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const data = JSON.stringify({ before: url(beforePath), after: url(afterPath), entries, condensed, clips }).replaceAll('<', '\\u003c')
await writeFile(join(out, 'index.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulation contact evidence</title>
<style>
:root{color-scheme:dark;font:16px/1.5 system-ui;background:#101517;color:#e2e8e5}body{max-width:1440px;margin:auto;padding:28px}h1{font-size:32px;margin-bottom:8px}h2{font-size:21px}p{max-width:1000px;color:#bbc8c2}a{color:#b6dc81}select,button{font:inherit;background:#25312c;color:inherit;border:1px solid #617165;border-radius:4px;padding:7px 12px;margin-right:12px}.media{display:grid;grid-template-columns:1fr 1fr;gap:18px}figure{margin:0}img,video{width:100%;background:#080d0b;border:1px solid #405048}figcaption{margin:7px 0 16px}table{border-collapse:collapse;font:13px/1.4 ui-monospace,monospace;width:100%}th,td{padding:7px 10px;text-align:right;border-bottom:1px solid #35423c}th:first-child,td:first-child{text-align:left;overflow-wrap:anywhere}th{color:#c2d99f;position:sticky;top:0;background:#17201b}.scroll{overflow:auto;max-height:650px}details{margin:20px 0}.bad{color:#ffab91}.pass{color:#b6dc81}small{color:#a4b3aa}label{display:inline-block;margin:16px 0}.note{border-left:3px solid #adc47a;padding-left:16px}@media(max-width:800px){body{padding:16px}.media{grid-template-columns:1fr}h1{font-size:25px}}
</style>
<h1>Ground and contact evidence</h1>
<p>41 catalogue entries, measured before and after. Signed vertical gaps are in millimetres: positive floats, negative penetrates. The contact tolerance is 2 mm at world scale. The SO-101 is displayed at 2.5× real size, so this is a stricter 0.8 mm real tolerance.</p>
<p>The boat has an intentional 80 mm keel draft and 40 mm buoy draft. Its reported contact error subtracts that draft; the CSV retains the signed raw gap. Raised feet, airborne vehicles and suspended loads require nonpenetration, rather than zero clearance. The shared assembly viewer deliberately has no floor contract.</p>
<p>The original boat baseline was recorded as free motion. Its retained raw water gaps are compared retrospectively with the same 80 mm draft in the condensed table. Clear-mode parts report minimum clearance separately. The original dog had no stance state, so its baseline motion envelope includes all feet; the corrected gait distinguishes stance and swing.</p>
<p class="note">The probe records transformed mesh vertices every rendered frame, including the delayed model swap. On slopes it raycasts the lower hull and also retains the world-lowest vertex reading. “Not measured” identifies a baseline part or phase without a matching measurement, rather than treating it as zero. Motion is driven by paired test phones; the six arms also run repeatable floor and block reach fixtures. Wall and gripper tests use collision envelopes, with a sphere narrow phase for claw prizes.</p>
<p><a href="contact-table.csv" download>Every part and phase (CSV)</a> · <a href="condensed.csv" download>Condensed table (CSV)</a> · <a href="${url(beforePath)}/contacts.json">Raw before report</a> · <a href="${url(afterPath)}/contacts.json">Raw after report</a></p>
<label>Simulation <select id="sim"></select></label><label>Picture <select id="picture"><option value="moving-side">Ground-level motion</option><option value="side">Ground-level rest</option><option value="overview">Overview</option><option value="floor">Arm at floor</option><option value="block">Arm on block</option></select></label>
<div class="media"><figure><img id="beforeImage" alt="Before contact correction"><figcaption id="beforeCaption">Before</figcaption><video id="beforeVideo" controls preload="none" muted></video></figure><figure><img id="afterImage" alt="After contact correction"><figcaption id="afterCaption">After</figcaption><video id="afterVideo" controls preload="none" muted></video></figure></div>
<p id="result"></p><label>Measurement phase <select id="phase"></select></label>
<div class="scroll"><table id="parts"></table></div>
<details open><summary>All simulations: maximum absolute support error</summary><p>Only frames requiring contact contribute to these bounds. Penetration includes clear parts and collision envelopes. Free-space motion is excluded.</p><div class="scroll"><table id="summary"></table></div></details>
<script>
const data=${data};
const $=id=>document.getElementById(id), esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'), f=n=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(3):'—';
function table(id,head,rows){$(id).innerHTML='<thead><tr>'+head.map(s=>'<th>'+esc(s)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(s=>'<td>'+esc(s)+'</td>').join('')+'</tr>').join('')+'</tbody>'}
$('sim').innerHTML=data.entries.map(e=>'<option>'+esc(e.id)+'</option>').join('');
table('summary',data.condensed[0],data.condensed.slice(1));
function measure(){const e=data.entries.find(e=>e.id===$('sim').value), p=$('phase').value, b=e.before?.rows.find(r=>r.phase===p)?.parts??[], a=e.after.rows.find(r=>r.phase===p)?.parts??[], norm=s=>s.replaceAll('/ankle/','/');const keys=[...new Set([...b,...a].map(p=>norm(p.part)))];table('parts',['Part','Before range mm','After range mm','Touch error mm','Penetration mm','Mode','Shadow','Frames'],keys.map(k=>{const x=b.find(p=>norm(p.part)===k),y=a.find(p=>norm(p.part)===k);return[k,x?f(x.minMm)+' … '+f(x.maxMm):'not measured',y?f(y.minMm)+' … '+f(y.maxMm):'not measured',f(y?.touchMaxMm),f(y?.penetrationMm),y?.mode,y?.shadow?'yes':'—',y?.frames]}));}
function picture(){const e=data.entries.find(e=>e.id===$('sim').value);for(const side of ['before','after']){const img=$(side+'Image'),kind=$('picture').value;img.onerror=()=>{img.onerror=null;img.src=data[side]+'/'+e.id+'-side.png';$(side+'Caption').textContent=side+' · requested view unavailable; showing rest side view'};const replay=side==='before'?e.beforeMedia:null;const prefix=replay?.files.includes(e.id+'-'+kind+'.png')?replay.path:data[side];img.src=prefix+'/'+e.id+'-'+kind+'.png';$(side+'Caption').textContent=side+' · '+kind;const v=$(side+'Video');const video=side==='before'&&e.beforeMedia?.video?e.beforeMedia:null;v.src=data.clips[e.id]?.[side]?.[kind]??(video?video.path+'/'+video.video:e[side]?.video?data[side]+'/'+e[side].video:'');v.hidden=!v.getAttribute('src');}}
function select(){const e=data.entries.find(e=>e.id===$('sim').value);document.querySelector('.media').style.display=e.id==='viewer'?'none':'grid';$('phase').innerHTML=[...new Set([...e.before?.rows??[],...e.after.rows].map(r=>r.phase))].map(p=>'<option>'+p+'</option>').join('');$('phase').value=e.after.rows.some(r=>r.phase==='model-rest')?'model-rest':$('phase').value;$('result').textContent=e.after.note??('Model: '+(e.after.model??'procedural')+' · '+e.after.rows.reduce((n,r)=>n+r.frames,0)+' sampled frames · '+(e.after.metrics?.calls??'?')+' draws / '+(e.after.metrics?.triangles??'?')+' triangles');picture();measure();}
$('sim').onchange=select;$('picture').onchange=picture;$('phase').onchange=measure;select();
</script></html>`)
console.log(`Contact viewer: ${join(out, 'index.html')}`)
console.log(`${entries.length} entries, ${rows.length - 1} part/phase comparisons`)
