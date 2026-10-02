/** Retain the first two seconds and every failed compositor sample; full frame dumps stay in TEMP. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { distill, rawRun } from './distill.mjs'
import { flickerEvents, warmupFailure } from './warmup.mjs'

export async function startupProof(out, result) {
  await mkdir(out, { recursive: true })
  const raw = rawRun(out), events = flickerEvents(result), failure = warmupFailure(result)
  const failed = new Set(events.map(event => event.source === 'screen' ? event.index :
    result.screens.reduce((nearest, frame, index, frames) => Math.abs(frame.t - event.t) < Math.abs(frames[nearest].t - event.t) ? index : nearest, 0)))
  if (failure && !failed.size && result.screens.length) failed.add(result.screens.length - 1)
  const screens = result.screens.filter(f => f.t >= 0 && (failure || f.t <= 2000))
  if (!screens.length) {
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: 1, fps: 60, frames: [] }))
    await distill(out)
    return
  }
  const metadata = await sharp(Buffer.from(screens[0].image, 'base64')).metadata()
  const width = 390, height = Math.round(width * metadata.height / metadata.width)
  const frames = []
  for (const [i, f] of screens.entries()) {
    const path = `${String(i).padStart(4, '0')}.jpg`
    await writeFile(join(raw, path), Buffer.from(f.image, 'base64'))
    frames.push({ path, timeMs: f.t, failed: failed.has(result.screens.indexOf(f)) })
  }
  for (const event of events.filter(e => e.source === 'screen')) {
    const context = result.screens.slice(Math.max(0, event.index - 2), event.index + 3)
    await sharp({ create: { width: width * context.length, height, channels: 3, background: '#111' } })
      .composite(await Promise.all(context.map(async (f, i) => ({ input: await sharp(Buffer.from(f.image, 'base64')).resize(width, height, { fit: 'contain' }).toBuffer(), left: width * i, top: 0 })))).jpeg().toFile(join(out, `event-${event.index}.jpg`))
    await writeFile(join(out, `event-${event.index}.json`), JSON.stringify({ event, samples: context.map(f => ({ t: f.t, mean: f.mean, area: f.area })) }, null, 2))
  }
  const times = Array.from({ length: 9 }, (_, i) => i * 250)
  const samples = times.map(t => screens.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
  await sharp({ create: { width: width * samples.length, height, channels: 3, background: '#111' } })
    .composite(await Promise.all(samples.map(async (f, i) => ({ input: await sharp(Buffer.from(f.image, 'base64')).resize(width, height, { fit: 'contain' }).toBuffer(), left: width * i, top: 0 })))).jpeg().toFile(join(out, 'startup-2s.jpg'))
  await writeFile(join(out, 'startup-2s.json'), JSON.stringify(samples.map((f, i) => ({ targetMs: times[i], sampledMs: f.t })), null, 2))
  await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 60, frames }, null, 2))
  await distill(out)
}
