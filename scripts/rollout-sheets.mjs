/** Contact sheets supplement the full-resolution evidence, without entering the public build. */
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
const [phase = 'after', ...names] = process.argv.slice(2)
const out = `artifacts/codex-rollout/${phase}`
await mkdir(`${out}/sheets`, { recursive: true })
for (const name of names) {
  const views = [['desktop',0,0,800,500],['close',800,0,800,500],['scene',0,500,800,500],['phone',800,500,250,541],['landscape',1050,500,550,255]]
  const layers = []
  for (const [view,left,top,width,height] of views) layers.push({ input: await sharp(`${out}/${name}-${view}.png`).resize(width,height,{fit:'contain',background:'#171e22'}).toBuffer(), left, top })
  await sharp({ create: { width:1600,height:1041,channels:3,background:'#171e22' } }).composite(layers).png().toFile(`${out}/sheets/${name}.png`)
}
