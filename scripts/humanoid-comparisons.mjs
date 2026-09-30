/** Assemble preserved and revised authoring evidence; never downloads or generates imagery. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const root = resolve(process.argv[2] || 'artifacts/humanoid/phase-3b')
const versions = process.argv[3] === 'v2-v3' ? ['v2', 'v3'] : ['v1', 'v2']
const out = join(root, 'comparisons')
await mkdir(out, { recursive: true })
const names = ['keel', 'morrow'].flatMap((name) =>
  ['front', 'three-quarter', 'side', 'back'].map((view) => `${name}-${view}`),
)
names.push('pair-arena')
const title = (text, width, height = 72) =>
  Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#101314"/><text x="${width < 720 ? 18 : 36}" y="48" fill="#e6ebdf" font-family="sans-serif" font-size="${width < 720 ? 18 : 30}">${text}</text></svg>`,
  )
for (const name of names) {
  const panels = []
  for (const [i, version] of versions.entries()) {
    // Centre crops use all of the source's vertical resolution. Each full source
    // remains beside the sheet for inspecting details at the original 4K size.
    const input = await sharp(join(root, version, 'renders', `${name}.png`))
      .resize(1920, 2088, { fit: 'cover' })
      .png()
      .toBuffer()
    panels.push({ input, left: i * 1920, top: 72 })
    panels.push({ input: title(`${name} / ${version}`, 1920), left: i * 1920, top: 0 })
  }
  await sharp({ create: { width: 3840, height: 2160, channels: 4, background: '#101314' } })
    .composite(panels)
    .png()
    .toFile(join(out, `${name}-${versions.join('-')}.png`))
}

for (const size of versions[1] === 'v3' ? ['desktop', 'phone'] : []) {
  const width = size === 'desktop' ? 1440 : 412,
    height = size === 'desktop' ? 900 : 915
  const steps = ['shoulders', 'elbows', 'wrists', 'spine', 'hips', 'knees', 'ankles', 'head']
  for (const name of [...names, ...(versions[1] === 'v3' ? steps.map((step) => `range-${step}`) : [])]) {
    const panels = []
    for (const [i, version] of versions.entries()) {
      panels.push({
        input: await sharp(join(root, version, 'sim', `${size}-${name}.png`))
          .resize(width, height, { fit: 'contain', background: '#101314' })
          .png()
          .toBuffer(),
        left: i * width,
        top: 72,
      })
      panels.push({ input: title(`${name} / ${version}`, width), left: i * width, top: 0 })
    }
    await sharp({ create: { width: width * 2, height: height + 72, channels: 4, background: '#101314' } })
      .composite(panels)
      .png()
      .toFile(join(out, `${size}-${name}-${versions.join('-')}.png`))
  }
}

// A native 64 px figure and an unfiltered 8× enlargement of the same pixels.
const silhouettes = []
for (const [i, name] of ['keel-front', 'keel-side', 'morrow-front', 'morrow-side'].entries()) {
  const small = await sharp(join(root, versions[1], 'renders', `${name}-silhouette.png`))
    .trim()
    .resize({ height: 64 })
    .png()
    .toBuffer()
  await writeFile(join(root, `${name}-64.png`), small)
  const metadata = await sharp(small).metadata()
  const large = await sharp(small).resize({ height: 512, kernel: 'nearest' }).png().toBuffer()
  silhouettes.push({ input: title(`${name} / 64 px`, 960), left: i * 960, top: 0 })
  silhouettes.push({ input: small, left: i * 960 + Math.round((960 - metadata.width) / 2), top: 180 })
  silhouettes.push({ input: large, left: i * 960 + Math.round((960 - metadata.width * 8) / 2), top: 360 })
}
await sharp({ create: { width: 3840, height: 1080, channels: 4, background: '#f4f5ee' } })
  .composite(silhouettes)
  .png()
  .toFile(join(root, 'silhouette-sheet.png'))

const manifest = []
for (const name of ['keel', 'keel-lod', 'morrow', 'morrow-lod', 'humanoid-arena']) {
  const bytes = await readFile(`public/models/${name}.glb`)
  const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString())
  const primitives = doc.meshes.flatMap((mesh) => mesh.primitives)
  manifest.push({
    name,
    bytes: bytes.length,
    triangles: primitives.reduce((sum, primitive) => sum + doc.accessors[primitive.indices].count / 3, 0),
    draws: primitives.length,
    textures: doc.textures?.length ?? 0,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
await writeFile(join(root, 'asset-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Comparison evidence: ${out}`)
