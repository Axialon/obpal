import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncGoals } from '../src/sim/arm/feetech'
import { FeetechDriver, ROS_DEFAULTS, RosDriver, SerialTextDriver, type RosOptions } from '../src/sim/arm/drivers'

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

/** A serial port that keeps what was written to it. */
const bench = () => {
  const wrote: Uint8Array[] = []
  return { wrote, port: { write: async (b: Uint8Array) => { wrote.push(b) } } }
}

describe('a driver’s own hold, sent when the screen stops a live arm', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends S to the ob.Pal serial sketch, and says nothing without a port', async () => {
    const driver = new SerialTextDriver()
    await expect(driver.hold()).resolves.toBeUndefined()
    const { wrote, port } = bench()
    ;(driver as unknown as { port: typeof port }).port = port
    await driver.hold()
    expect(wrote.map((b) => new TextDecoder().decode(b))).toEqual(['S\n'])
  })

  describe('Feetech servos', () => {
    const wired = (raw: (number | null)[]) => {
      const driver = new FeetechDriver()
      const { wrote, port } = bench()
      Object.assign(driver as unknown as object, { port, raw })
      return { driver, wrote }
    }

    it('re-aims every servo at where it last reported itself, with torque left on', async () => {
      const raw = [2048, 2100, 2200, 2300, 2400, 3000]
      const { driver, wrote } = wired(raw)
      await driver.hold()
      expect(wrote).toHaveLength(1)
      // One broadcast sync write of the goal position for servos 1 to 6, and no packet that lets go of them.
      expect(hex(wrote[0]).startsWith('ff ff fe')).toBe(true)
      expect(wrote[0][4]).toBe(0x83)
      expect(Array.from(wrote[0])).toEqual(Array.from(syncGoals(raw.map((pos, i) => ({ id: i + 1, pos })))))
    })

    it('sends nothing while a servo has not reported, or without a port', async () => {
      const held = wired([2048, 2100, null, 2300, 2400, 3000])
      await held.driver.hold()
      expect(held.wrote).toHaveLength(0)
      await expect(new FeetechDriver().hold()).resolves.toBeUndefined()
    })
  })

  describe('ROS 2 through rosbridge', () => {
    const raw = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    const wired = (o: Partial<RosOptions>, reported: (number | null)[] = raw) => {
      vi.stubGlobal('WebSocket', { OPEN: 1 })
      const driver = new RosDriver({ ...ROS_DEFAULTS, ...o })
      const sent: { op: string; topic: string; msg: Record<string, unknown> }[] = []
      Object.assign(driver as unknown as object, { ws: { readyState: 1, send: (m: string) => { sent.push(JSON.parse(m)) } }, raw: reported })
      return { driver, sent }
    }

    it('ends a trajectory where the joints are, at rest', async () => {
      const { driver, sent } = wired({ command: 'trajectory' })
      await driver.hold()
      expect(sent).toEqual([{
        op: 'publish',
        topic: ROS_DEFAULTS.topic,
        msg: { joint_names: ROS_DEFAULTS.joints, points: [{ positions: raw, velocities: [0, 0, 0, 0, 0, 0], time_from_start: { sec: 0, nanosec: 100_000_000 } }] },
      }])
    })

    it('tells a position controller to stay where the joints are', async () => {
      const { driver, sent } = wired({ command: 'array', topic: '/arm/positions' })
      await driver.hold()
      expect(sent).toEqual([{ op: 'publish', topic: '/arm/positions', msg: { layout: { dim: [], data_offset: 0 }, data: raw } }])
    })

    it('holds the joints it has named when the others are left unnamed, and nothing while a named one has not reported', async () => {
      const partial = wired({ command: 'array', joints: ['a', 'b', 'c', 'd', 'e', ''] }, [1, 2, 3, 4, 5, null])
      await partial.driver.hold()
      expect(partial.sent.map((m) => m.msg.data)).toEqual([[1, 2, 3, 4, 5]])
      const unreported = wired({ command: 'array' }, [1, 2, null, 4, 5, 6])
      await unreported.driver.hold()
      expect(unreported.sent).toHaveLength(0)
    })

    it('says nothing when the socket is not open', async () => {
      const { driver, sent } = wired({})
      Object.assign(driver as unknown as object, { ws: null })
      await driver.hold()
      expect(sent).toHaveLength(0)
    })
  })
})
