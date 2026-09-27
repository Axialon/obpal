/**
 * Feetech STS serial bus servos: the STS3215 in the open-source SO-100 and SO-101 arms (LeRobot). One half-duplex bus
 * at 1 Mbaud. Packets are FF FF id length instruction params… checksum, where length counts the instruction, the
 * params and the checksum, and the checksum is the inverted low byte of id + length + instruction + params. STS
 * registers are little-endian. Positions run 0–4095 for one turn, 2048 in the middle.
 */
export const STS = {
  baud: 1_000_000,
  broadcast: 0xfe,
  ping: 0x01,
  read: 0x02,
  write: 0x03,
  syncWrite: 0x83,
  /** Registers. */
  torque: 0x28,
  goal: 0x2a,
  present: 0x38,
  /** Ticks per turn. */
  turn: 4096,
} as const

export function checksum(body: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < body.length; i++) sum += body[i]
  return ~sum & 0xff
}

/** One instruction packet for servo `id` (or the broadcast id). */
export function packet(id: number, instr: number, params: number[] = []): Uint8Array {
  const body = [id & 0xff, params.length + 2, instr, ...params.map((p) => p & 0xff)]
  return Uint8Array.from([0xff, 0xff, ...body, checksum(body)])
}

const u16 = (v: number) => { const x = Math.max(0, Math.min(0xffff, Math.round(v))); return [x & 0xff, x >> 8] }

/** Goal positions for several servos in one packet (no replies). */
export function syncGoals(goals: { id: number; pos: number }[]): Uint8Array {
  const params = [STS.goal, 2]
  for (const g of goals) params.push(g.id, ...u16(Math.max(0, Math.min(STS.turn - 1, g.pos))))
  return packet(STS.broadcast, STS.syncWrite, params)
}

/** Torque on or off for several servos in one packet (no replies). Off leaves the arm limp. */
export function syncTorque(ids: number[], on: boolean): Uint8Array {
  const params: number[] = [STS.torque, 1]
  for (const id of ids) params.push(id, on ? 1 : 0)
  return packet(STS.broadcast, STS.syncWrite, params)
}

/** Ask one servo where it is: it answers with a status packet carrying two bytes. */
export const readPosition = (id: number) => packet(id, STS.read, [STS.present, 2])

export interface Status { id: number; error: number; params: number[] }

/**
 * Take the first complete status packet from `buf`: returns it (null when the bytes were noise or a bad checksum)
 * and how many bytes were used, or null while more bytes are needed.
 */
export function takeStatus(buf: number[]): { status: Status | null; used: number } | null {
  let i = 0
  while (i + 1 < buf.length && !(buf[i] === 0xff && buf[i + 1] === 0xff)) i++
  if (i + 1 >= buf.length) return buf.length > 1 ? { status: null, used: buf.length - 1 } : null
  // Some adapters repeat the header byte.
  let h = i + 2
  while (buf[h] === 0xff) h++
  if (buf.length < h + 2) return null
  const len = buf[h + 1]
  if (len < 2 || len > 250) return { status: null, used: h }
  const end = h + 2 + len
  if (buf.length < end) return null
  const body = buf.slice(h, end - 1)
  if (checksum(body) !== buf[end - 1]) return { status: null, used: h }
  return { status: { id: body[0], error: body[2], params: body.slice(3) }, used: end }
}

/** A present position from a status packet (bit 15 marks a negative value). */
export function positionOf(s: Status): number | null {
  if (s.params.length < 2) return null
  const v = s.params[0] | (s.params[1] << 8)
  return v & 0x8000 ? -(v & 0x7fff) : v
}
