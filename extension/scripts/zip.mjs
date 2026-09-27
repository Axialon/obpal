/**
 * A plain zip writer on node:zlib (deflate + crc32), shared by the release packers (extension/scripts/pack.mjs,
 * desktop/pack.mjs). No dependencies.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

/** Every file under `dir`, sorted. */
export async function files(dir) {
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

/**
 * Zip `paths`, named relative to `base` (forward slashes). `entries` adds or overrides entries by name with their
 * own bytes, for files assembled in memory.
 */
export async function zip(paths, base, entries = {}) {
  const items = []
  for (const path of paths) items.push({ name: relative(base, path).replace(/\\/g, '/'), data: await readFile(path), when: (await stat(path)).mtime })
  for (const [name, data] of Object.entries(entries)) {
    const i = items.findIndex((x) => x.name === name)
    const item = { name, data: Buffer.from(data), when: new Date() }
    if (i >= 0) items[i] = item
    else items.push(item)
  }
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name: n, data, when } of items) {
    const name = Buffer.from(n, 'utf8')
    const packed = deflateRawSync(data, { level: 9 })
    const { time, date } = dosTime(when)
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
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
