/** Synthetic exchange folders, removed after every case. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { archive, saveExchange } from '../scripts/astra/common.mjs'
import { ensureLayout, finishIntake, movePreserving, retainedRequests, tidyExchange } from '../scripts/astra/layout.mjs'

const fixture = async action => {
  const root = mkdtempSync(join(tmpdir(), 'obpal-astra-layout-test-')), outbox = join(root, 'outbox')
  try { ensureLayout(outbox); await action({ root, outbox, inbox: join(root, 'inbox') }) }
  finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
}
const request = (outbox, stage) => saveExchange(outbox, stage, 'Request', archive({ 'TASK.md': 'Synthetic task' }, { kind: 'request', stage }), 'Synthetic upload prompt')
export const layoutCases = [
  { name: 'verification holds results without an upload marker and next pack attaches both ZIPs in one turn', run: () => fixture(({ outbox }) => {
    const first = request(outbox, 'earlier')
    const marker = join(outbox, 'UPLOAD-THIS-earlier.prompt.txt'), before = readFileSync(marker, 'utf8')
    const held = saveExchange(outbox, 'earlier', 'Return', archive({ 'RESULT.md': 'check failed (exit 7)' }, { kind: 'result', stage: 'earlier', result: 'failed' }), 'held result prompt', { held: true })
    assert.match(held, /held[\\/]earlier/); assert(existsSync(held.replace(/\.zip$/, '.prompt.txt')))
    assert.equal(readFileSync(marker, 'utf8'), before)
    assert.deepEqual(readdirSync(outbox).filter(name => name.endsWith('.zip')), [first.split(/[\\/]/).at(-1)])
    const next = saveExchange(outbox, 'next', 'Request', archive({}, { kind: 'request', stage: 'next' }), 'next bounded task', { attach: held })
    assert(existsSync(held)); assert(existsSync(next))
    const copy = join(outbox, held.split(/[\\/]/).at(-1))
    assert.deepEqual(readFileSync(copy), readFileSync(held)); assert(existsSync(copy.replace(/\.zip$/, '.prompt.txt')))
    const combined = readFileSync(join(outbox, 'UPLOAD-THIS-next.prompt.txt'), 'utf8')
    assert(combined.includes(next.split(/[\\/]/).at(-1))); assert(combined.includes(held.split(/[\\/]/).at(-1)))
    assert.match(combined, /Fold.*one turn/); assert.match(combined, /next bounded task/); assert.match(combined, /failed, blocked and unexecuted/)
    assert.deepEqual(tidyExchange(outbox), [])
    request(outbox, 'later'); assert(!existsSync(copy)); assert(existsSync(held))
  }) },
  { name: 'held verification alone produces no loose upload, and invalid attachments preserve the current upload', run: () => fixture(({ outbox, root }) => {
    const held = saveExchange(outbox, 'prior', 'Return', archive({}, { kind: 'result', stage: 'prior' }), 'held prompt', { held: true })
    assert.equal(readdirSync(outbox).filter(name => /zip$|UPLOAD-THIS/.test(name)).length, 0)
    const current = request(outbox, 'current')
    const pack = attach => saveExchange(outbox, 'next', 'Request', archive({}, { kind: 'request', stage: 'next' }), 'next', { attach })
    assert.throws(() => pack(current), /held Return/)
    const outside = join(root, 'outside.zip'); writeFileSync(outside, readFileSync(held))
    assert.throws(() => pack(outside), /outbox\/held/)
    writeFileSync(held, 'corrupt ZIP'); assert.throws(() => pack(held))
    assert(existsSync(current)); assert(existsSync(join(outbox, 'UPLOAD-THIS-current.prompt.txt')))
  }) },

  { name: 'a new pack moves earlier loose stages to sent and keeps only the current upload', run: () => fixture(({ outbox }) => {
    const first = request(outbox, 'earlier'), current = request(outbox, 'current')
    assert.equal(existsSync(first), false); assert.equal(existsSync(current), true)
    assert.equal(retainedRequests(outbox).length, 2)
    assert.equal(existsSync(join(outbox, 'sent/earlier', first.split(/[\\/]/).at(-1))), true)
    assert.equal(existsSync(join(outbox, 'UPLOAD-THIS-current.prompt.txt')), true)
    assert.equal(readdirSync(outbox).filter(name => name.endsWith('.zip')).length, 1)
    assert.deepEqual(tidyExchange(outbox), [])
  }) },
  { name: 'tidy dry-run leaves files unchanged and repeated real tidy makes no further moves', run: () => fixture(({ outbox }) => {
    request(outbox, 'current'); writeFileSync(join(outbox, 'old-notes.txt'), 'preserve notes')
    const planned = tidyExchange(outbox, { dryRun: true }); assert.equal(planned.length, 1); assert.equal(existsSync(join(outbox, 'old-notes.txt')), true)
    const moves = tidyExchange(outbox); assert.equal(moves.length, 1); assert.equal(readFileSync(moves[0], 'utf8'), 'preserve notes')
    assert.deepEqual(tidyExchange(outbox), [])
  }) },
  { name: 'intake moves accepted and refused ZIPs, retaining refusal Returns under sent', run: () => fixture(({ outbox, inbox }) => {
    const accepted = join(inbox, 'accepted.zip'); writeFileSync(accepted, 'synthetic accepted ZIP')
    const processed = finishIntake(outbox, accepted, 'accepted', true); assert.equal(existsSync(accepted), false)
    assert.equal(readFileSync(processed.receivedPath, 'utf8'), 'synthetic accepted ZIP')
    const refused = join(inbox, 'refused.zip'); writeFileSync(refused, 'synthetic refused ZIP')
    const result = saveExchange(outbox, 'refused', 'Return', archive({}, { kind: 'result', stage: 'refused', result: 'failed' }), 'refusal prompt', { upload: false })
    const moved = finishIntake(outbox, refused, 'refused', false, result)
    assert.equal(existsSync(refused), false); assert.match(moved.receivedPath, /refused[\\/]refused/)
    assert.equal(existsSync(moved.refusalPath), true); assert.equal(existsSync(moved.refusalPath.replace(/\.zip$/, '.prompt.txt')), true)
    assert.equal(existsSync(result), false)
  }) },
  { name: 'moves never overwrite an existing destination and request lookup traverses sent', run: () => fixture(({ outbox, root }) => {
    const zip = request(outbox, 'retained'), destination = join(outbox, 'sent/retained/nested', zip.split(/[\\/]/).at(-1))
    movePreserving(zip, destination); assert.deepEqual(retainedRequests(outbox), [destination])
    const source = join(root, 'source.txt'), target = join(root, 'target.txt'); writeFileSync(source, 'new'); writeFileSync(target, 'old')
    const moved = movePreserving(source, target); assert.equal(readFileSync(target, 'utf8'), 'old'); assert.equal(readFileSync(moved, 'utf8'), 'new')
  }) },
  { name: 'tidy leaves pending inbox uploads alone and writes short layout READMEs', run: () => fixture(({ outbox, inbox, root }) => {
    const pending = join(inbox, 'pending.zip'); writeFileSync(pending, archive({}, { kind: 'stage', stage: 'pending' }))
    tidyExchange(outbox, { root }); assert.equal(existsSync(pending), true)
    assert.match(readFileSync(join(outbox, 'README.md'), 'utf8'), /sent/); assert.match(readFileSync(join(inbox, 'README.md'), 'utf8'), /processed/)
  }) },
  { name: 'synthetic dry-run requests are archived and their returned paths stay usable', run: () => fixture(({ outbox }) => {
    const zip = request(outbox, 'dry-run-fixture')
    assert.equal(existsSync(zip), true); assert.match(zip, /archive[\\/]dry-run/)
    assert.equal(readdirSync(outbox).filter(name => name.endsWith('.zip')).length, 0)
    assert.deepEqual(tidyExchange(outbox), [])
  }) },
]
