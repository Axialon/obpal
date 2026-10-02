/** Keep upload files loose and all completed exchanges in folders. Moves never replace existing files. */
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { loadArchive, stageId } from './common.mjs'
import { plainDirectory } from '../lib/maintenance.mjs'

export const OUTBOX_README = '# Astra outbox\n\nLoose files are the current upload: the newest Request ZIP and prompt, an explicitly attached Return ZIP and prompt, and UPLOAD-THIS-<stage>.prompt.txt naming the ZIPs to upload together.\n\nVerification writes its Return ZIP and prompt to held/<stage>/ without an upload prompt. Build the next request with pnpm run astra:pack -- --stage <next> --task <brief.md> --attach <held-return.zip>; upload both named ZIPs and paste UPLOAD-THIS once. Astra folds the prior verification into the next stage in one turn.\n\nsent/<stage>/ holds earlier or already uploaded exchanges. archive/dry-run/ holds synthetic exchanges; archive/superseded/ holds older versions and unclassified notes. Nothing is deleted. Run pnpm run astra:tidy -- --dry-run to preview moves.\n'
export const INBOX_README = '# Astra inbox\n\nLoose stage ZIPs await intake. Intake moves accepted ZIPs to processed/<stage>/ and refused ZIPs to refused/<stage>/. Refusal Returns stay beside the retained exchanges in outbox/sent/<stage>/. Verification Returns wait in outbox/held/<stage>/ until the next astra:pack --attach <held-return.zip> copies one into the upload set. Upload it with the new Request and paste UPLOAD-THIS once. Nothing is deleted.\n'
export function ensureLayout(outbox, { dryRun = false } = {}) {
  const inbox = join(dirname(resolve(outbox)), 'inbox')
  plainDirectory(outbox); plainDirectory(inbox)
  if (!dryRun) {
    mkdirSync(outbox, { recursive: true }); mkdirSync(inbox, { recursive: true })
    for (const [folder, text] of [[outbox, OUTBOX_README], [inbox, INBOX_README]]) if (!existsSync(join(folder, 'README.md'))) writeFileSync(join(folder, 'README.md'), text, { flag: 'wx' })
  }
  return inbox
}
export function exchangeInfo(path) {
  const name = basename(path)
  const marker = /^UPLOAD-THIS-([a-z0-9][a-z0-9-]*)\.prompt\.txt$/.exec(name)
  if (marker) return { stage: stageId(marker[1]), kind: 'marker', stem: name }
  const named = /^obpal-([a-z0-9][a-z0-9-]*)-(Request|Return)-(.+)\.(zip|prompt\.txt)$/.exec(name)
  if (named) return { stage: stageId(named[1]), kind: named[2], stem: name.replace(/\.(zip|prompt\.txt)$/, ''), zip: named[4] === 'zip' }
  if (name.endsWith('.zip')) {
    try { const manifest = loadArchive(path).manifest; return { stage: stageId(manifest.stage), kind: manifest.kind, stem: name.slice(0, -4), zip: true } } catch { /* unclassified files are still retained */ }
  }
  return { stage: 'unclassified', kind: 'note', stem: name }
}
export function movePreserving(source, destination, { dryRun = false } = {}) {
  plainDirectory(dirname(source)); plainDirectory(dirname(destination))
  if (lstatSync(source).isSymbolicLink()) throw new Error('Exchange move refuses links')
  let target = destination, n = 1
  const extension = /(?:\.prompt\.txt|\.[^./\\]+)$/.exec(destination)?.[0] || ''
  while (existsSync(target)) target = `${destination.slice(0, destination.length - extension.length)}-preserved-${n++}${extension}`
  console.log(`${dryRun ? 'would move' : 'move'} ${source} -> ${target}`)
  if (!dryRun) { mkdirSync(dirname(target), { recursive: true }); renameSync(source, target) }
  return target
}
const looseFiles = outbox => existsSync(outbox) ? readdirSync(outbox, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== 'README.md').map(entry => {
  const path = join(outbox, entry.name)
  return { path, ...exchangeInfo(path), at: statSync(path).mtimeMs }
}) : []
const newest = items => [...items].sort((a, b) => b.at - a.at || basename(b.path).localeCompare(basename(a.path)))[0]
export function tidyOutbox(outbox, { currentStage, dryRun = false } = {}) {
  ensureLayout(outbox, { dryRun })
  const files = looseFiles(outbox)
  const request = newest(files.filter(file => file.kind === 'Request' && file.zip))
  const returned = newest(files.filter(file => file.kind === 'Return' && file.zip))
  currentStage ??= request?.stage || returned?.stage
  const currentRequest = newest(files.filter(file => file.stage === currentStage && file.kind === 'Request' && file.zip))
  const marker = files.find(file => file.stage === currentStage && file.kind === 'marker')
  const upload = marker ? readFileSync(marker.path, 'utf8') : ''
  const currentReturn = newest(files.filter(file => file.kind === 'Return' && file.zip && (file.stage === currentStage || upload.includes(basename(file.path)))))
  const moves = []
  for (const file of files) {
    const dry = /(?:^|-)(?:dry-run|dryrun)(?:-|$)/.test(file.stage)
    if (!dry && (file.stem === currentReturn?.stem || file.stage === currentStage && (file.stem === currentRequest?.stem || file.kind === 'marker'))) continue
    const group = dry ? ['archive', 'dry-run'] : file.stage === currentStage || file.stage === 'unclassified' ? ['archive', 'superseded'] : ['sent']
    moves.push(movePreserving(file.path, join(outbox, ...group, file.stage, basename(file.path)), { dryRun }))
  }
  return moves
}
/** Validate a held result before changing the current upload; keep the held original intact. */
export function heldReturn(outbox, path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('--attach requires a regular held Return ZIP')
  plainDirectory(dirname(resolve(path)))
  const returned = loadArchive(path)
  if (returned.manifest.kind !== 'result') throw new Error('--attach requires a held Return ZIP')
  const folder = join(resolve(outbox), 'held', stageId(returned.manifest.stage))
  plainDirectory(folder)
  if (dirname(resolve(path)) !== folder) throw new Error('--attach requires a Return in outbox/held/<stage>/')
  if (exchangeInfo(path).kind !== 'Return') throw new Error('--attach requires a named held Return ZIP')
  const prompt = path.replace(/\.zip$/, '.prompt.txt')
  if (!path.endsWith('.zip') || !existsSync(prompt) || lstatSync(prompt).isSymbolicLink()) throw new Error('Held Return prompt is missing or linked')
  return { path, prompt, stage: returned.manifest.stage }
}
export function copyHeldReturn(outbox, returned) {
  for (const source of [returned.path, returned.prompt]) copyFileSync(source, join(outbox, basename(source)), constants.COPYFILE_EXCL)
  return basename(returned.path)
}
export function prepareRequest(outbox, stage) {
  stageId(stage); ensureLayout(outbox)
  // A fresh request supersedes every previous loose upload for this same stage.
  for (const file of looseFiles(outbox).filter(file => file.stage === stage)) movePreserving(file.path, join(outbox, 'archive', 'superseded', stage, basename(file.path)))
  tidyOutbox(outbox, { currentStage: stage })
}
export function uploadMarker(outbox, stage, prompt) {
  const path = join(outbox, `UPLOAD-THIS-${stageId(stage)}.prompt.txt`)
  if (existsSync(path)) movePreserving(path, join(outbox, 'archive', 'superseded', stage, basename(path)))
  writeFileSync(path, prompt, { flag: 'wx' })
}
export function retainedRequests(outbox, kind = 'Request') {
  plainDirectory(outbox)
  const found = []
  const walk = (folder, recursive) => {
    if (!existsSync(folder)) return
    plainDirectory(folder)
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isSymbolicLink()) continue
      if (recursive && entry.isDirectory()) walk(path, true)
      else if (entry.isFile() && exchangeInfo(path).kind === kind && entry.name.endsWith('.zip')) found.push(path)
    }
  }
  walk(outbox, false); walk(join(outbox, 'sent'), true)
  return found
}
export function finishIntake(outbox, returned, stage, accepted, refusal) {
  const inbox = ensureLayout(outbox); stageId(stage)
  const moved = movePreserving(returned, join(inbox, accepted ? 'processed' : 'refused', stage, basename(returned)))
  if (refusal) {
    const refusalPath = movePreserving(refusal, join(outbox, 'sent', stage, basename(refusal)))
    const prompt = refusal.replace(/\.zip$/, '.prompt.txt')
    if (existsSync(prompt)) movePreserving(prompt, refusalPath.replace(/\.zip$/, '.prompt.txt'))
    return { receivedPath: moved, refusalPath }
  }
  return { receivedPath: moved }
}
/** Repair leftovers from interrupted intake by matching its receipt or refusal to the exact received bytes. */
export function tidyExchange(outbox, { root, dryRun = false } = {}) {
  const moves = tidyOutbox(outbox, { dryRun }), inbox = ensureLayout(outbox, { dryRun })
  if (root && existsSync(inbox)) for (const entry of readdirSync(inbox, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue
    const path = join(inbox, entry.name), info = exchangeInfo(path)
    if (info.stage === 'unclassified') continue
    const receipt = join(root, 'artifacts/astra', info.stage, 'stage.json')
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
    const state = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null
    if (state?.stage === info.stage && state.received_sha256 === digest) moves.push(movePreserving(path, join(inbox, 'processed', info.stage, entry.name), { dryRun }))
    else for (const report of retainedRequests(outbox, 'Return')) {
      let manifest
      try { manifest = loadArchive(report).manifest } catch { continue }
      if (manifest.stage === info.stage && manifest.received_sha256 === digest && manifest.result === 'failed') {
        moves.push(movePreserving(path, join(inbox, 'refused', info.stage, entry.name), { dryRun })); break
      }
    }
  }
  return moves
}
