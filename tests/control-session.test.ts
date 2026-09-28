import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Remote } from '@obpal/host'
import { ControlSession } from '../src/sim/control-space'

function session() {
  vi.stubGlobal('document', { querySelector: () => null })
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const listeners = new Map<string, (...args: any[]) => void>()
  const remote = { participants: [], setValues: vi.fn(), on: (type: string, fn: (...args: any[]) => void) => listeners.set(type, fn) }
  const control = new ControlSession(remote as unknown as Remote, 'studio')
  const send = (who = 'one', active = true) => listeners.get('value')!({ id: 'control.aim', v: JSON.stringify({ aim: [0.5, -0.3], tilt: [0.2, 0.1], active }) }, { id: who })
  return { control, remote, listeners, send, time: (n: number) => { now = n } }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('per-controller calibration and scope lifecycle', () => {
  it('expires stale input and honors an explicit inactive sample', () => {
    const s = session(); s.send()
    expect(s.control.aim('one', 1299)).not.toBeNull()
    expect(s.control.aim('one', 1300)).toBeNull()
    s.time(1400); s.send('one', false)
    expect(s.control.aim('one', 1401)).toBeNull()
  })
  it('separates players and clears scope-transition motion before echoing the new scope', () => {
    const s = session(); s.send(); s.send('two')
    s.listeners.get('value')!({ id: 'control.scope', v: 'scene' }, { id: 'one' })
    expect(s.control.scope('one')).toBe('scene')
    expect(s.control.scope('two')).toBe('object')
    expect(s.control.aim('one')).toBeNull(); expect(s.control.aim('two')).not.toBeNull()
    expect(s.remote.setValues).toHaveBeenLastCalledWith({ 'control.scope': 'scene' }, 'one')
  })
  it('requests a fresh neutral for claims and panel actions, then clears old input on mode and leave', () => {
    const s = session(); s.send(); s.control.position('one')
    expect(s.control.aim('one')).toBeNull()
    expect(s.remote.setValues).toHaveBeenLastCalledWith({ 'control.position': 1 }, 'one')
    s.control.position('one')
    expect(s.remote.setValues).toHaveBeenLastCalledWith({ 'control.position': 2 }, 'one')
    s.send(); s.listeners.get('mode')!(2, { id: 'one' })
    expect(s.control.aim('one')).toBeNull()
    s.send(); s.listeners.get('leave')!({ id: 'one' })
    expect(s.control.calibrated('one')).toBe(false)
    expect(s.control.aim('one')).toBeNull()
  })
  it('re-centres the input without replacing another player’s sample', () => {
    const s = session(); s.send(); s.send('two')
    s.listeners.get('recenter')!({ id: 'one' })
    expect(s.control.aim('one')?.aim).toEqual([0, 0])
    expect(s.control.aim('two')?.aim).toEqual([0.5, -0.3])
  })
  it('waits for the phone to capture its new neutral before accepting in-flight motion', () => {
    const s = session(); s.send(); s.control.position('one')
    expect(s.control.awaitingPosition('one')).toBe(true)
    s.send()
    expect(s.control.aim('one')).toBeNull()
    s.listeners.get('recenter')!({ id: 'one' })
    expect(s.control.awaitingPosition('one')).toBe(false)
    s.send()
    expect(s.control.aim('one')).not.toBeNull()
    s.control.position('legacy')
    expect(s.control.awaitingPosition('legacy')).toBe(false)
  })
})
