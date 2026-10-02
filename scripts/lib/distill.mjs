/** Turn raw frame runs into verified, bounded review proof before unlinking any source. */
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join, relative, resolve, dirname, basename, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { entries, plainDirectory, safeRelative, hashFile } from './maintenance.mjs'
import { sanitize, classify } from './decision-model.mjs'

export const rawFolder = name => /^(?:raw|frames|.*-frames|intermediate(?:-.*)?|scratch|iter(?:ation)?[-_]?\d+|run-\d+)$/.test(name)
const raster = path => /\.(png|jpe?g|webp|avif)$/i.test(path)
const local = (root, path) => relative(root, path).replaceAll('\\', '/')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

/** Missing samples and threshold breaches remain failures regardless of optional model advice. */
export function classifyFrames(frames, expectedCount) {
  const missing = Number.isSafeInteger(expectedCount) ? Math.max(0, expectedCount - frames.length) : 0
  const failures = frames.filter(frame => frame.failed || (Number.isFinite(frame.diff) && Number.isFinite(frame.threshold) && frame.diff > frame.threshold)).map(frame => frame.path)
  return { status: missing || failures.length ? 'fail' : !frames.length || !frames.every(frame => typeof frame.failed === 'boolean' || Number.isFinite(frame.threshold)) ? 'unclassified' : 'pass', missing, failures }
}

export function ffmpegExecutable() {
  if (process.env.OBPAL_FFMPEG) return process.env.OBPAL_FFMPEG
  const candidates = (process.env.PATH || '').split(delimiter).map(dir => join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  if (process.platform === 'win32') {
    // The optional full build can be installed outside PATH; discover it without recording machine paths.
    const drive = process.env.SystemDrive || 'C:'
    candidates.push(join(drive + '/', 'ffmpeg-6.0-full_build', 'bin', 'ffmpeg.exe'))
  }
  return candidates.find(existsSync) || 'ffmpeg'
}

/** The helper creates raw storage in TEMP, while the run descriptor and summaries stay at the review destination. */
export function rawRun(out) {
  plainDirectory(out); mkdirSync(out, { recursive: true })
  const raw = mkdtempSync(join(tmpdir(), 'obpal-raw-'))
  save(join(out, 'raw-run.json'), { version: 1, rawRoot: raw })
  return raw
}

export async function distill(directory, { keepRaw = false, model = false, provider, runner, encode = encodeClip } = {}) {
  const root = resolve(directory); plainDirectory(root)
  let inventory = entries(root)
  if (inventory.some(file => file.link)) throw new Error('Linked evidence excluded')
  for (const file of inventory.filter(file => basename(file.path) === 'raw-run.json' && dirname(file.path) !== root)) await distill(dirname(file.path), { keepRaw, model, provider, runner, encode })
  inventory = entries(root)
  const descriptor = join(root, 'raw-run.json')
  let rawRoot = root
  if (existsSync(descriptor)) {
    rawRoot = resolve(json(descriptor).rawRoot)
    safeRelative(resolve(tmpdir()), rawRoot); plainDirectory(rawRoot)
    if (!basename(rawRoot).startsWith('obpal-raw-')) throw new Error('Unexpected raw run directory')
  }
  const rawInventory = entries(rawRoot)
  if (rawInventory.some(file => file.link)) throw new Error('Linked raw evidence excluded')
  const sources = rawInventory.filter(file => raster(file.path) && (rawRoot !== root || local(root, file.path).split('/').slice(0, -1).some(rawFolder))).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  if (!sources.length && existsSync(join(root, 'distill-manifest.json'))) {
    const previous = json(join(root, 'distill-manifest.json'))
    // A repeated run must not silently return a stale manifest after reports were edited.
    for (const file of previous.files) {
      safeRelative(root, join(root, file.path)); plainDirectory(dirname(join(root, file.path)))
      if (!existsSync(join(root, file.path)) || await hashFile(join(root, file.path)) !== file.sha256) throw new Error('Existing distilled proof changed; use a fresh evidence directory')
    }
    return previous
  }
  const metadataPath = join(root, 'evidence-frames.json')
  const metadata = existsSync(metadataPath) ? json(metadataPath) : {}
  const frames = [], previousPixels = new Map(), measuredFrames = new Map((metadata.frames || []).map(frame => [frame.path, frame]))
  for (const source of sources) {
    const path = local(rawRoot, source.path), measured = measuredFrames.get(path) || {}
    const info = statSync(source.path)
    const pixels = await sharp(readFileSync(source.path)).resize(64, 48, { fit: 'fill' }).greyscale().raw().toBuffer()
    const prior = previousPixels.get(dirname(path))
    const diff = prior ? pixels.reduce((sum, value, i) => sum + Math.abs(value - prior[i]), 0) / pixels.length : 0
    previousPixels.set(dirname(path), pixels)
    frames.push({ diff, scoreSource: Number.isFinite(measured.diff) ? 'supplied frame metrics' : 'adjacent 64x48 grayscale mean difference', ...measured, path, bytes: info.size, createdAt: info.birthtime.toISOString(), modifiedAt: info.mtime.toISOString(), sha256: await hashFile(source.path) })
  }
  const classification = classifyFrames(frames, metadata.expectedCount ?? metadata.frames?.length)
  const missingPaths = (metadata.frames || []).filter(expected => !frames.some(frame => frame.path === expected.path)).map(frame => frame.path)
  if (missingPaths.length) { classification.status = 'fail'; classification.missing = Math.max(classification.missing, missingPaths.length); classification.missingPaths = missingPaths }
  const beforeBytes = inventory.reduce((n, file) => n + file.size, 0) + (rawRoot === root ? 0 : sources.reduce((n, file) => n + file.size, 0))
  const proof = join(root, 'distilled'); mkdirSync(proof, { recursive: true }); plainDirectory(proof)
  // Separate independent sequences so a failure in one scenario never discards another scenario's keyframes.
  const groups = new Map()
  frames.forEach((frame, i) => { const group = dirname(frame.path); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(i) })
  const chosen = new Set(), clips = [], clipped = new Set()
  for (const indexes of groups.values()) {
    chosen.add(indexes[0]); chosen.add(indexes.at(-1))
    const worst = indexes.reduce((a, b) => (frames[b].diff ?? 0) > (frames[a].diff ?? 0) ? b : a)
    chosen.add(worst)
    for (const i of indexes) if (classification.failures.includes(frames[i].path)) {
      chosen.add(i)
      // A short neighbourhood only; never encode a successful full run.
      if (clipped.has(i)) continue
      const at = indexes.indexOf(i), near = indexes.slice(Math.max(0, at - 12), at + 13)
      near.forEach(j => clipped.add(j))
      const target = join(proof, `failure-${i}.mp4`)
      const encoder = await encode(near.map(j => sources[j].path), target, Number.isFinite(metadata.fps) && metadata.fps > 0 && metadata.fps <= 120 ? metadata.fps : 24)
      const checked = spawnSync(ffmpegExecutable(), ['-v', 'error', '-i', target, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' })
      if (checked.status !== 0) throw new Error('Failure clip verification failed; raw frames retained')
      clips.push({ path: local(root, target), encoder })
    }
  }
  const selected = [...chosen].sort((a, b) => a - b), tiles = [], outputs = []
  for (const i of selected) {
    const target = join(proof, `keyframe-${i}.webp`)
    writeFileSync(target, await sharp(readFileSync(sources[i].path)).resize({ width: 960, height: 720, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer())
    // Decode every retained image before authorizing raw removal.
    await sharp(readFileSync(target)).raw().toBuffer()
    outputs.push({ path: local(root, target), source: frames[i].path })
    if (tiles.length < 24) tiles.push({ input: await sharp(readFileSync(target)).resize(240, 180, { fit: 'contain', background: '#111' }).png().toBuffer(), left: (tiles.length % 4) * 240, top: Math.floor(tiles.length / 4) * 180 })
  }
  if (tiles.length) {
    const sheet = join(proof, 'contact-sheet.webp')
    writeFileSync(sheet, await sharp({ create: { width: 960, height: Math.ceil(tiles.length / 4) * 180, channels: 3, background: '#111' } }).composite(tiles).webp({ quality: 75 }).toBuffer())
    await sharp(readFileSync(sheet)).raw().toBuffer(); outputs.push({ path: local(root, sheet) })
  }
  save(join(proof, 'raw-frames.json'), { count: frames.length, bytes: frames.reduce((n, frame) => n + frame.bytes, 0), frames })
  save(join(proof, 'classification.json'), classification)
  outputs.push({ path: local(root, join(proof, 'raw-frames.json')) }, { path: local(root, join(proof, 'classification.json')) }, ...clips)
  if (model || provider) {
    const schema = { type: 'object', properties: { status: { type: 'string', enum: ['pass', 'fail', 'unclassified'] }, note: { type: 'string' } }, required: ['status', 'note'], additionalProperties: false }
    const images = provider === 'vision' ? outputs.filter(output => output.source).slice(0, 2).map(output => join(root, output.path)) : []
    const advisory = await classify({ status: classification.status, note: 'Deterministic classification retained' }, classification, schema, { runner, provider: provider || 'model', images, guidance: provider === 'vision' ? 'Inspect only the attached retained keyframes, a bounded sample of this run. Describe visible issues or uncertainty in note. Advisory only. Preserve status; summarize measured failures. No length target.' : 'Advisory only. Preserve status; summarize the measured failures. No length target.' }, candidate => candidate.status === classification.status && sanitize(candidate.note) === candidate.note)
    save(join(proof, 'advisory.json'), { advisory: true, ...(provider === 'vision' ? { images: images.map(path => local(root, path)) } : {}), ...advisory }); outputs.push({ path: local(root, join(proof, 'advisory.json')) })
  }
  for (const output of outputs) { output.bytes = statSync(join(root, output.path)).size; output.sha256 = await hashFile(join(root, output.path)) }
  // Preserve every metric/report, including JSON inside legacy raw directories, in the archive manifest.
  const sourcePaths = new Set(sources.map(source => source.path))
  const summaries = entries(root).filter(file => !sourcePaths.has(file.path) && !file.path.endsWith('distill-manifest.json') && file.path !== descriptor)
  for (const file of summaries) if (!outputs.some(output => output.path === local(root, file.path))) outputs.push({ path: local(root, file.path), bytes: file.size, sha256: await hashFile(file.path) })
  const manifest = { version: 1, verified: true, at: new Date().toISOString(), rawCount: frames.length, rawBytes: frames.reduce((n, frame) => n + frame.bytes, 0), beforeBytes, classification, files: outputs, keyframes: selected.map(i => frames[i].path), clips, keepRaw }
  save(join(root, 'distill-manifest.json'), manifest)
  for (const output of outputs) if (await hashFile(join(root, output.path)) !== output.sha256) throw new Error('Distilled proof changed; raw retained')
  for (let i = 0; i < sources.length; i++) if (await hashFile(sources[i].path) !== frames[i].sha256) throw new Error('Raw frames changed; refusing deletion')
  const current = entries(rawRoot).filter(file => raster(file.path) && (rawRoot !== root || local(root, file.path).split('/').slice(0, -1).some(rawFolder)))
  if (current.length !== sources.length || current.some(file => file.link || !sourcePaths.has(file.path))) throw new Error('Raw inventory changed; refusing deletion')
  if (!keepRaw) {
    for (const source of sources) { safeRelative(rawRoot, source.path); plainDirectory(dirname(source.path)); unlinkSync(source.path) }
    if (existsSync(descriptor)) unlinkSync(descriptor)
  }
  manifest.rawDeleted = !keepRaw
  const proofBytes = entries(root).filter(file => file.path !== join(root, 'distill-manifest.json')).reduce((n, file) => n + file.size, 0) + (keepRaw && rawRoot !== root ? manifest.rawBytes : 0)
  // Include the final manifest itself; settle the digit count before writing the measured total.
  manifest.afterBytes = 0
  for (;;) {
    const total = proofBytes + Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n')
    if (total === manifest.afterBytes) break
    manifest.afterBytes = total
  }
  save(join(root, 'distill-manifest.json'), manifest)
  console.log(`Distilled ${frames.length} frames: ${beforeBytes} -> ${manifest.afterBytes} bytes; ${classification.status}; raw ${keepRaw ? 'retained by request' : 'deleted after verification'}`)
  return manifest
}

async function encodeClip(paths, target, fps) {
  // A concat inventory references only verified raw frames; ffmpeg receives argument arrays.
  const list = target + '.txt'
  writeFileSync(list, paths.map(path => `file '${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'\nduration ${1 / fps}`).join('\n') + '\n')
  try {
    for (const codec of ['h264_nvenc', 'libx264']) {
      const result = spawnSync(ffmpegExecutable(), ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'scale=960:720:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', codec, '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', target], { windowsHide: true, encoding: 'utf8' })
      if (result.status === 0) return codec
    }
    throw new Error('Failure clip encoding failed; raw frames retained')
  } finally { unlinkSync(list) }
}
