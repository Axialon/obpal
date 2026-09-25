/**
 * Package extension/dist for release: extension/release/obpal-link-<version>.zip, plus obpal-link.zip (same bytes)
 * so a "latest" download link never changes. manifest.json sits at the zip's root, as the Chrome Web Store and
 * "Load unpacked" (after unzipping) both expect.
 *
 * Usage: pnpm run pack:extension (builds first), or node extension/scripts/pack.mjs after a build.
 * No dependencies: a plain zip writer on node:zlib (deflate + crc32).
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(root, 'dist')
const out = resolve(root, 'release')

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])))
  return nested.flat().sort()
}

/** DOS date/time for the zip headers (local time, 2-second resolution). */
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

async function zip(paths, base) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const path of paths) {
    const name = Buffer.from(relative(base, path).replace(/\\/g, '/'), 'utf8')
    const data = await readFile(path)
    const packed = deflateRawSync(data, { level: 9 })
    const { time, date } = dosTime((await stat(path)).mtime)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, packed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(paths.length, 8)
  end.writeUInt16LE(paths.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'))
const bytes = await zip(await files(dist), dist)
await mkdir(out, { recursive: true })
const versioned = join(out, `obpal-link-${manifest.version}.zip`)
await writeFile(versioned, bytes)
await writeFile(join(out, 'obpal-link.zip'), bytes)
console.log(`ob.Pal Link ${manifest.version}: ${versioned} (${(bytes.length / 1024).toFixed(1)} KB)`)
