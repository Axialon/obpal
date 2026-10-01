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
