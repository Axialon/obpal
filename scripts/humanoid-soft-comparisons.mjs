/** Assemble original concept/model evidence from the final renders; no downloaded assets. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const root = resolve(process.argv[2] ?? 'artifacts/humanoid-third')
const boards = join(root, 'comparisons'), thumbnails = join(root, 'thumbnails')
await mkdir(boards, { recursive: true })
await mkdir(thumbnails, { recursive: true })
const directions = [['A', 'cairn', 'Mineral elastomer, rounded face and two soft eyes'], ['B', 'rill', 'Ash technical knit and a single horizon light'], ['C', 'hush', 'Charcoal knit hood and a recessed two-eye visor']]
const title = (text, width, height = 72) => Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#101314"/><text x="32" y="48" fill="#edf0e7" font-family="sans-serif" font-size="30">${text}</text></svg>`)
const nameOf = name => name[0].toUpperCase()+name.slice(1)
if (process.argv.includes('--pilot')) {
  // Read retained, verified frames rather than re-rendering or concealing a view.
  const sources = [join(root, 'before/cpu'), join(root, 'after/clearance/cpu')]
  const frame = async (directory, source) => {
    const manifest = JSON.parse(await readFile(join(directory, 'distill-manifest.json')))
    if (!manifest.verified) throw new Error('Unverified pilot frames')
    const record = manifest.files.find(file => file.source === source)
    if (!record) throw new Error(`Missing matched view: ${source}`)
    const bytes = await readFile(join(directory, record.path))
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('Changed retained pilot frame')
    return bytes
  }
  const pairs = [
    ['heads', ['head-front', 'head-three-quarter'], 'studio', false],
    ['neutral', ['front', 'side', 'back', 'three-quarter'], 'neutral', false],
    ['silhouettes', ['front', 'side', 'three-quarter'], 'silhouettes', true],
  ]
  for (const [name, views, mode, silhouette] of pairs) {
    const cells = [], w = 800, h = silhouette ? 560 : 480
    for (const [row, view] of views.entries()) for (const [column, directory] of sources.entries()) {
      const suffix = silhouette ? 'silhouette' : 'draft', file = `cairn-i-${view}-${suffix}`
      const bytes = await frame(directory, `${mode}/${file}/${file}.png`)
      cells.push({ input: await sharp(bytes).flatten({ background: silhouette ? '#f4f4f0' : '#101314' }).resize(w, h-72, { fit: 'contain', background: silhouette ? '#f4f4f0' : '#101314' }).webp().toBuffer(), left: column*w, top: row*h+72 })
      cells.push({ input: title(`${column ? 'Cairn I pilot' : 'D2 baseline'} / ${view}`, w), left: column*w, top: row*h })
    }
    await sharp({ create: { width: w*2, height: h*views.length, channels: 3, background: '#101314' } }).composite(cells).webp({ quality: 90 }).toFile(join(boards, `${name}.webp`))
  }
  await writeFile(join(boards, 'scope.json'), JSON.stringify({ scope: 'Matched CPU cache renders, not live performance. True rest, same orthographic camera and lights; neutral floor has no contact-shadow dependence. Original perspective concepts remain separate uncalibrated references; D4 approval is pending.', sourceManifests: sources.map(directory => join(directory, 'distill-manifest.json')) }, null, 2))
  console.log(`Matched Cairn pilot comparisons: ${boards}`)
  process.exit(0)
}
for (const [letter, name] of directions) {
  const panels = []
  for (const [column, form] of ['concept', 'i', 'ii'].entries()) {
    const source = form === 'concept' ? join(root, 'concepts', letter, 'hero.png') : join(root, 'renders', `${name}-${form}-three-quarter.png`)
    const picture = await sharp(source).resize(1280, 2088, { fit: 'cover' }).png().toBuffer()
    panels.push({ input: picture, left: column*1280, top: 72 })
    panels.push({ input: title(`${nameOf(name)} / ${form === 'concept' ? 'original concept' : `Form ${form.toUpperCase()}`}`, 1280), left: column*1280, top: 0 })
  }
  await sharp({ create: { width: 3840, height: 2160, channels: 4, background: '#101314' } }).composite(panels).png().toFile(join(boards, `${name}-concept-model.png`))
  const heads = []
  for (const [row, form] of ['i', 'ii'].entries()) for (const [column, view] of ['head-front', 'head-three-quarter'].entries()) {
    heads.push({ input: await sharp(join(root, 'renders', `${name}-${form}-${view}.png`)).resize(1920, 1008, { fit: 'cover' }).png().toBuffer(), left: column*1920, top: row*1080+72 })
    heads.push({ input: title(`${nameOf(name)} / Form ${form.toUpperCase()} / ${view.replace('head-', '')}`, 1920), left: column*1920, top: row*1080 })
  }
  await sharp({ create: { width: 3840, height: 2160, channels: 4, background: '#101314' } }).composite(heads).png().toFile(join(boards, `${name}-heads.png`))
}
const silhouettes = []
for (const [column, name] of directions.flatMap(([, name]) => [`${name}-i`, `${name}-ii`]).entries()) {
  silhouettes.push({ input: title(`${nameOf(name.split('-')[0])} / Form ${name.split('-')[1].toUpperCase()}`, 640), left: column*640, top: 0 })
  for (const [row, view] of ['front', 'side'].entries()) {
    silhouettes.push({ input: await sharp(join(root, 'renders', `${name}-${view}-silhouette.png`)).resize(640, 640).png().toBuffer(), left: column*640, top: 90+row*760 })
    silhouettes.push({ input: title(view, 640), left: column*640, top: 730+row*760 })
    await sharp(join(root, 'renders', `${name}-${view}-silhouette.png`)).trim().resize({ height: 64 }).png().toFile(join(boards, `${name}-${view}-64.png`))
  }
}
await sharp({ create: { width: 3840, height: 1680, channels: 4, background: '#e9ece4' } }).composite(silhouettes).png().toFile(join(boards, 'silhouette-sheet.png'))

const manifest = []
for (const name of directions.flatMap(([, name]) => [`${name}-i`, `${name}-ii`]).flatMap(name => [name, name+'-lod'])) {
  const bytes = await readFile(`public/models/${name}.glb`)
  const doc = JSON.parse(bytes.subarray(20, 20+bytes.readUInt32LE(12)).toString())
  const primitives = doc.meshes.flatMap(mesh => mesh.primitives)
  const triangles = primitives.reduce((sum, primitive) => sum+doc.accessors[primitive.indices].count/3, 0)
  if (triangles >= (name.endsWith('-lod') ? 10000 : 25000) || bytes.length >= 1500000) throw new Error(`Asset budget exceeded: ${name}`)
  manifest.push({ name, bytes: bytes.length, triangles, draws: primitives.length, textures: doc.textures?.length ?? 0, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const preserved = []
for (const name of ['keel', 'keel-lod', 'morrow', 'morrow-lod']) {
  const bytes = await readFile(`public/models/${name}.glb`)
  const baseline = spawnSync('git', ['show', `master:public/models/${name}.glb`], { maxBuffer: 2_000_000 }).stdout
  if (!bytes.equals(baseline)) throw new Error(`Existing robot changed: ${name}`)
  preserved.push({ name, unchanged: true, sha256: createHash('sha256').update(bytes).digest('hex') })
}
await writeFile(join(root, 'asset-manifest.json'), JSON.stringify({ models: manifest, preserved }, null, 2))

const sections = []
for (const [letter, name, description] of directions) {
  const thumbs = []
  for (const form of ['i', 'ii']) for (const view of ['front', 'three-quarter', 'side', 'back', 'head-front', 'head-three-quarter']) {
    const file = `${name}-${form}-${view}.png`
    const metadata = await sharp(join(root, 'renders', file)).metadata()
    if (metadata.width !== 3840 || metadata.height !== 2160) throw new Error(`Missing 4K render: ${file}`)
    await sharp(join(root, 'renders', file)).resize({ width: 960 }).jpeg({ quality: 88 }).toFile(join(thumbnails, file.replace('.png', '.jpg')))
    thumbs.push(`<a href="renders/${file}"><img loading="lazy" src="thumbnails/${file.replace('.png', '.jpg')}" alt="${nameOf(name)}, Form ${form.toUpperCase()}, ${view}"><span>Form ${form.toUpperCase()} · ${view}</span></a>`)
  }
  sections.push(`<section id="${name}"><header><p>${letter} / ${nameOf(name)}</p><h2>${description}</h2></header><div class="comparison"><a href="comparisons/${name}-concept-model.png"><img loading="lazy" src="comparisons/${name}-concept-model.png" alt="Original concept beside ${nameOf(name)} forms I and II"></a><a href="comparisons/${name}-heads.png"><img loading="lazy" src="comparisons/${name}-heads.png" alt="${nameOf(name)} head studies, both forms"></a></div><div class="grid">${thumbs.join('')}</div><div class="sim"><a href="validation/desktop-${name}-forms-arena.png"><img loading="lazy" src="validation/desktop-${name}-forms-arena.png" alt="${nameOf(name)} forms in the actual desktop arena"></a><a href="validation/phone-${name}-forms-arena.png"><img loading="lazy" src="validation/phone-${name}-forms-arena.png" alt="${nameOf(name)} forms in the phone viewport"></a></div></section>`)
}
await writeFile(join(root, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cairn, Rill and Hush — six original forms</title><style>*{box-sizing:border-box}body{margin:0;padding:48px;background:#101314;color:#edf0e7;font:16px/1.55 system-ui}main{max-width:1600px;margin:auto}h1{font-size:clamp(28px,4vw,56px);line-height:1.05}h2{font-size:25px;font-weight:500}p{color:#adb7ab}a{color:inherit;text-decoration:none}nav{display:flex;gap:24px;flex-wrap:wrap;margin:32px 0}section{border-top:1px solid #394237;margin-top:64px;padding-top:28px}img{width:100%;display:block;border-radius:4px}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:28px 0}.grid span{display:block;font-size:13px;padding:8px 0;color:#adb7ab}.sim{display:grid;grid-template-columns:1fr 260px;gap:20px;align-items:start}@media(max-width:850px){body{padding:20px}.grid{grid-template-columns:repeat(2,1fr)}.comparison,.sim{grid-template-columns:1fr}.sim a:last-child{max-width:300px}}</style><main><p>ob.Pal / Original soft humanoids</p><h1>Cairn. Rill. Hush.<br>Three directions. Six forms.</h1><p>Form I: 1.73 m. Form II: 1.80 m, broader shoulders, narrower hips and a flatter chest. Default names for owner review.</p><p>Design notes: inspired by XPeng IRON's soft, human-proportioned presentation. All geometry and finishes are original; concept art is never shipped.</p><nav>${directions.map(([,name])=>`<a href="#${name}">${nameOf(name)}</a>`).join('')}<a href="concepts/index.html">Original concepts</a><a href="comparisons/silhouette-sheet.png">Silhouette sheet</a><a href="asset-manifest.json">Asset budgets and preserved originals</a><a href="validation/soft-roster-proof.json">Browser proof</a><a href="validation/clearance.json">Clearance audit</a><a href="validation/frame-budget.json">Five-minute run</a></nav>${sections.join('')}<section><h2>Six silhouettes</h2><a href="comparisons/silhouette-sheet.png"><img loading="lazy" src="comparisons/silhouette-sheet.png" alt="Front and side silhouettes of all six forms"></a><p>Phone viewports are emulated. Physical-phone frame rate, thermals and simultaneous camera inference remain unverified. Keel and Morrow's four GLBs match master byte for byte.</p></section></main></html>`)
console.log(`Review index: ${join(root, 'index.html')}`)
