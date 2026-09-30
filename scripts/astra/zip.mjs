/** Small ZIP transport: regular files, stored or deflated, with bounded expansion. No extraction to disk. */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export const LIMITS = { archive: 64 << 20, total: 128 << 20, member: 16 << 20, count: 10000 }

export function safePath(path) {
  if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9_./-]+$/.test(path)
    || path.split('/').some((p) => !p || p === '.' || p === '..' || p.endsWith('.')
      || /^\.git$/i.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error('Refused non-portable or traversing path')
  }
  return path
}

const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
const crc = (b) => {
  let n = 0xffffffff
  for (const v of b) n = table[(n ^ v) & 255] ^ (n >>> 8)
  return (n ^ 0xffffffff) >>> 0
}

export function writeZip(members) {
  const chunks = [], directory = [], seen = new Set()
  let offset = 0, total = 0
  if (Object.keys(members).length > LIMITS.count) throw new Error('ZIP member count cap')
  for (const [path, value] of Object.entries(members)) {
    safePath(path)
    if (seen.has(path.toLowerCase())) throw new Error('ZIP duplicate path')
    seen.add(path.toLowerCase())
    const name = Buffer.from(path), data = Buffer.from(value), packed = deflateRawSync(data)
    total += data.length
    if (data.length > LIMITS.member || total > LIMITS.total) throw new Error('ZIP size cap')
    const h = Buffer.alloc(30), d = Buffer.alloc(46), checksum = crc(data)
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8)
    h.writeUInt32LE(checksum, 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26)
    d.writeUInt32LE(0x02014b50); d.writeUInt16LE(0x314, 4); d.writeUInt16LE(20, 6); d.writeUInt16LE(0x800, 8); d.writeUInt16LE(8, 10)
    d.writeUInt32LE(checksum, 16); d.writeUInt32LE(packed.length, 20); d.writeUInt32LE(data.length, 24); d.writeUInt16LE(name.length, 28)
    d.writeUInt32LE((0o100644 << 16) >>> 0, 38); d.writeUInt32LE(offset, 42)
    chunks.push(h, name, packed); directory.push(d, name)
    offset += h.length + name.length + packed.length
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22), count = seen.size
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10)
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  const result = Buffer.concat([...chunks, central, end])
  if (result.length > LIMITS.archive) throw new Error('ZIP compressed size cap')
  return result
}

export function readZip(b) {
  if (!Buffer.isBuffer(b)) b = Buffer.from(b)
  if (b.length > LIMITS.archive || b.length < 22) throw new Error('ZIP archive size cap or truncated archive')
  let end = b.length - 22
  for (; end >= Math.max(0, b.length - 65557); end--) {
    if (b.readUInt32LE(end) === 0x06054b50 && end + 22 + b.readUInt16LE(end + 20) === b.length) break
  }
  if (end < Math.max(0, b.length - 65557) || b.readUInt32LE(end) !== 0x06054b50) throw new Error('ZIP end missing')
  const count = b.readUInt16LE(end + 10), size = b.readUInt32LE(end + 12), start = b.readUInt32LE(end + 16)
  if (b.readUInt32LE(end + 4) !== 0 || b.readUInt16LE(end + 8) !== count || count > LIMITS.count
    || start + size !== end) throw new Error('ZIP split, ZIP64 or malformed directory refused')
  const members = Object.create(null), seen = new Set(), ranges = []
  let at = start, total = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || b.readUInt32LE(at) !== 0x02014b50) throw new Error('ZIP directory truncated')
    const flags = b.readUInt16LE(at + 8), method = b.readUInt16LE(at + 10), checksum = b.readUInt32LE(at + 16)
    const packed = b.readUInt32LE(at + 20), length = b.readUInt32LE(at + 24), n = b.readUInt16LE(at + 28)
    const extra = b.readUInt16LE(at + 30), comment = b.readUInt16LE(at + 32), offset = b.readUInt32LE(at + 42)
    const mode = b.readUInt32LE(at + 38) >>> 16
    if (at + 46 + n + extra + comment > end || (flags & ~0x808) || ![0, 8].includes(method)
      || b.readUInt16LE(at + 34) || ((mode & 0o170000) && (mode & 0o170000) !== 0o100000)) throw new Error('ZIP unsupported member')
    const name = b.subarray(at + 46, at + 46 + n).toString('utf8')
    safePath(name)
    if (seen.has(name.toLowerCase())) throw new Error('ZIP duplicate path')
    seen.add(name.toLowerCase()); total += length
    if (length > LIMITS.member || total > LIMITS.total || offset + 30 > start) throw new Error('ZIP expansion cap or bad offset')
    if (b.readUInt32LE(offset) !== 0x04034b50 || b.readUInt16LE(offset + 6) !== flags || b.readUInt16LE(offset + 8) !== method) throw new Error('ZIP local header mismatch')
    const ln = b.readUInt16LE(offset + 26), le = b.readUInt16LE(offset + 28), dataAt = offset + 30 + ln + le
    if (dataAt + packed > start || b.subarray(offset + 30, offset + 30 + ln).toString('utf8') !== name) throw new Error('ZIP local path mismatch')
    if (!(flags & 8) && (b.readUInt32LE(offset + 14) !== checksum || b.readUInt32LE(offset + 18) !== packed || b.readUInt32LE(offset + 22) !== length)) throw new Error('ZIP local sizes mismatch')
    if (ranges.some(([a, z]) => offset < z && dataAt + packed > a)) throw new Error('ZIP overlapping members')
    ranges.push([offset, dataAt + packed])
    const compressed = b.subarray(dataAt, dataAt + packed)
    const data = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, length) }) : Buffer.from(compressed)
    if (data.length !== length || crc(data) !== checksum) throw new Error('ZIP length or CRC mismatch')
    members[name] = data
    at += 46 + n + extra + comment
  }
  if (at !== end) throw new Error('ZIP directory size mismatch')
  return members
}
