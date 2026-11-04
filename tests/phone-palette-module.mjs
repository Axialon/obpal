/** Exercise the complete phone module's real imports without starting a browser. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const original = new URL('../scripts/phone-mobile-layout.mjs', import.meta.url)
const source = (await readFile(original, 'utf8')).replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, specifier) => `from ${quote}${new URL(specifier, original).href}${quote}`)
const dir = await mkdtemp(join(tmpdir(), 'obpal-phone-module-')), file = join(dir, 'phone.mjs')
try {
  await writeFile(file, `${source}\nexport { paletteHitEvidence }\n`, { flag: 'wx' })
  const { paletteHitEvidence } = await import(pathToFileURL(file).href)
  let boundsRead = 0
  const observed = [], sampling = 'fixture: sampling reached after geometry', restoration = 'fixture: restoration reached after geometry'
  const target = {
    count: async () => 2, nth() { return this }, first() { return this },
    evaluateAll: async () => 'product', getAttribute: async () => 'product',
    evaluate: async fn => {
      if (fn.constructor.name === 'AsyncFunction') throw Error(sampling)
      return { hasRoom: true, from: 0, to: 0, available: { height: 200 } }
    },
    boundingBox: async () => { boundsRead++; return { x: 0, y: 0, width: 46, height: 46 } },
    click: async () => { throw Error(restoration) },
  }
  const phone = { locator: () => target, bringToFront: async () => {}, evaluate: async () => {} }
  await assert.rejects(paletteHitEvidence(phone, async ({ stage, reason }) => { observed.push({ stage, reason }) }), error =>
    error instanceof AggregateError && error.errors.length === 2 && error.errors.every(e => !(e instanceof ReferenceError)))
  assert.deepEqual(observed, [{ stage: 'primary', reason: sampling }, { stage: 'restoration', reason: restoration }])
  assert.equal(boundsRead, 4)
  console.log(JSON.stringify({ realGeometryReads: boundsRead, samplingReached: true, restorationReached: true, browserLaunched: false }))
} finally {
  await unlink(file)
  await rmdir(dir)
}
