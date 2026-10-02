import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { classify, runVision } from '../scripts/lib/decision-model.mjs'
import { distill, rawRun } from '../scripts/lib/distill.mjs'

const roots = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'obpal-vision-test-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
const schema = { type: 'object', properties: { status: { type: 'string', enum: ['pass', 'fail', 'unclassified'] }, note: { type: 'string' } }, required: ['status', 'note'], additionalProperties: false }
const request = { images: ['fixture.png'], prompt: 'untrusted inline evidence', schema, timeoutMs: 100, model: 'local-vision' }
const response = { answer: { status: 'fail', note: 'Visible contrast needs review' }, model: 'local-vision', ms: 12, tokens: { input: 8, output: 7, total: 15 } }
function stub(output, code = 0, check = () => {}, hang = false) {
  return (binary, args, opts) => {
    check(binary, args, opts)
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true }
    if (!hang) queueMicrotask(() => { child.stdout.emit('data', output); child.emit('close', code) })
    return child
  }
}
describe('shared advisory vision runner', () => {
  it('uses an argument array, strict schema and Node for a configured mjs entry', async () => {
    let schemaPath = ''
    const result = await runVision({ ...request, executable: 'fixture-lv.mjs', execute: stub(JSON.stringify(response), 0, (binary, args, opts) => {
      expect(binary).toBe(process.execPath); expect(opts.shell).toBe(false)
      expect(args).toContain('--image'); expect(args).toContain('fixture.png')
      schemaPath = args[args.indexOf('--schema') + 1]
      expect(JSON.parse(readFileSync(schemaPath, 'utf8'))).toEqual(schema)
      expect(args[args.indexOf('--prompt') + 1]).toBe(request.prompt)
    }) })
    expect(result.failed).toBeUndefined()
    expect(JSON.parse(result.output)).toEqual(response.answer)
    expect(result.usage).toEqual({ input_tokens: 8, output_tokens: 7 })
    expect(existsSync(schemaPath)).toBe(false)
  })
  it('handles busy, missing, malformed, invalid, overflowing and timed-out runners', async () => {
    for (const result of [
      await runVision({ ...request, execute: stub('', 3) }),
      await runVision({ ...request, execute: stub('bad-json') }),
      await runVision({ ...request, execute: stub(JSON.stringify({ ...response, answer: { status: 'pass' } })) }),
      await runVision({ ...request, execute: stub('x'.repeat(65_000)) }),
      await runVision({ ...request, execute: stub('', 0, undefined, true), timeoutMs: 5 }),
    ]) expect(result.failed).toBeTruthy()
    const baseline = { status: 'fail', note: 'Measured failure retained' }
    const result = await classify(baseline, {}, schema, { provider: 'vision', images: ['fixture.png'], runner: req => runVision({ ...req, executable: join(temp(), 'missing-lv') }) })
    expect(result.mode).toBe('extractive'); expect(result.status).toBe('fail')
    expect(result.model).toBe('local-vision')
  })
  it('passes retained keyframes and never promotes a measured failure', async () => {
    const root = temp(), raw = rawRun(root); roots.push(raw)
    for (const name of ['0.png', '1.png', '2.png']) await sharp({ create: { width: 80, height: 60, channels: 3, background: '#aabbcc' } }).png().toFile(join(raw, name))
    writeFileSync(join(root, 'evidence-frames.json'), JSON.stringify({ expectedCount: 4 }))
    let called = 0
    const result = await distill(root, { provider: 'vision', runner: async (req) => {
      called++
      expect(req.images).toHaveLength(2)
      for (const image of req.images) expect(existsSync(image)).toBe(true)
      expect(req.prompt).toContain('Advisory only')
      return { output: JSON.stringify({ status: 'pass', note: 'looks fine' }), model: 'local-vision' }
    } })
    expect(called).toBe(1); expect(result.classification.status).toBe('fail')
    const advisory = JSON.parse(readFileSync(join(root, 'distilled/advisory.json'), 'utf8'))
    expect(advisory.advisory).toBe(true); expect(advisory.status).toBe('fail'); expect(advisory.mode).toBe('extractive')
    expect(existsSync(join(raw, '0.png'))).toBe(false)
    expect(result.files.some((file) => file.path === 'distilled/advisory.json' && file.sha256)).toBe(true)
  })
  it('accepts advisory notes while retaining status and token counts', async () => {
    const result = await classify({ status: 'unclassified', note: 'No measurement' }, {}, schema, { provider: 'vision', images: ['fixture.png'], runner: async req => {
      expect(req.images).toEqual(['fixture.png'])
      return { output: JSON.stringify({ status: 'unclassified', note: 'Human review needed' }), model: 'qwen3.5-9b-q8_0', usage: { input_tokens: 4, output_tokens: 5 } }
    } }, candidate => candidate.status === 'unclassified')
    expect(result.mode).toBe('vision'); expect(result.status).toBe('unclassified')
    expect(result.tokens).toEqual({ in: 4, out: 5, cached: null })
  })
})
