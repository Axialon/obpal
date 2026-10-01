import { expect, it } from 'vitest'
import { dotClock } from '../packages/host/src/dot-field'

function clock() {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  const doc = new EventTarget() as Document
  Object.defineProperty(doc, 'hidden', { value: false, writable: true })
  Object.defineProperty(doc, 'defaultView', { value: {
    requestAnimationFrame: (frame: FrameRequestCallback) => { frames.set(++id, frame); return id },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  } })
  return { doc, frames, step(now: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame(now)) } }
}

it('shares one request and the same timestamp, then releases finite subscriptions', () => {
  const c = clock(), observed: number[] = []
  dotClock(now => { observed.push(now); return false }, c.doc)
  const stop = dotClock(now => { observed.push(now); return true }, c.doc)
  expect(c.frames.size).toBe(1)
  c.step(530)
  expect(observed).toEqual([530, 530])
  expect(c.frames.size).toBe(1)
  stop(); stop()
  expect(c.frames.size).toBe(0)
})

it('stops requests in a hidden document and resumes the current time without replay', () => {
  const c = clock(), observed: number[] = []
  dotClock(now => { observed.push(now); return now < 1200 }, c.doc)
  Object.defineProperty(c.doc, 'hidden', { value: true, writable: true })
  c.doc.dispatchEvent(new Event('visibilitychange'))
  expect(c.frames.size).toBe(0)
  c.step(800)
  expect(observed).toEqual([])
  Object.defineProperty(c.doc, 'hidden', { value: false, writable: true })
  c.doc.dispatchEvent(new Event('visibilitychange'))
  c.step(1600)
  expect(observed).toEqual([1600])
  expect(c.frames.size).toBe(0)
})
