import { describe, expect, it } from 'vitest'
import { holdForPhone, holdReload, RELOAD_KEY, RELOAD_WINDOW_MS, recoverer, reloadHeld, type RecoverEnv } from '../src/ui/recover'

/** A page in a tab: a clock, a sessionStorage that lives across its reloads, and a count of the reloads. */
function tab(over: Partial<RecoverEnv> = {}) {
  const data = new Map<string, string>()
  const seen = { reloads: 0, clock: 1_000_000 }
  const env: RecoverEnv = {
    now: () => seen.clock,
    storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } },
    held: () => false,
    reachable: async () => true,
    reload: () => { seen.reloads++ },
    ...over,
  }
  return { env, data, seen, recover: recoverer(env) }
}

describe('a page that outlives a deploy reloads itself, once', () => {
  it('reloads on a failed chunk and writes the time first, so the page that comes back knows', async () => {
    const t = tab()
    expect(await t.recover()).toBe(true)
    expect(t.seen.reloads).toBe(1)
    expect(t.data.get(RELOAD_KEY)).toBe('1000000')
  })

  it('never loops: a failure right after a reload, or any time inside the window, leaves the page alone', async () => {
    const t = tab()
    expect(await t.recover()).toBe(true)
    // The page reloads: a new page in the same tab (the same storage) meets the same failure.
    for (const wait of [0, 50, 5_000, RELOAD_WINDOW_MS - 1]) {
      t.seen.clock = 1_000_000 + wait
      expect(await tab({ storage: t.env.storage, now: () => t.seen.clock, reload: () => { t.seen.reloads++ } }).recover()).toBe(false)
    }
    expect(t.seen.reloads).toBe(1)
  })

  it('reloads again for a later deploy, once the window has passed', async () => {
    const t = tab()
    expect(await t.recover()).toBe(true)
    t.seen.clock += RELOAD_WINDOW_MS
    expect(await t.recover()).toBe(true)
    expect(t.seen.reloads).toBe(2)
    expect(t.data.get(RELOAD_KEY)).toBe(String(1_000_000 + RELOAD_WINDOW_MS))
  })

  it('counts a time in the future (a clock set back) as recent, and ignores a value that isn\'t a time', async () => {
    const back = tab()
    back.data.set(RELOAD_KEY, String(back.seen.clock + 86_400_000))
    expect(await back.recover()).toBe(false)
    const junk = tab()
    junk.data.set(RELOAD_KEY, 'not a time')
    expect(await junk.recover()).toBe(true)
  })

  it('drops the failures that arrive while it is deciding: many chunks fail at once, one reload', async () => {
    let answer: (v: boolean) => void = () => {}
    const t = tab({ reachable: () => new Promise((r) => { answer = r }) })
    const first = t.recover()
    const rest = await Promise.all([t.recover(), t.recover()])
    expect(rest).toEqual([false, false])
    answer(true)
    expect(await first).toBe(true)
    expect(t.seen.reloads).toBe(1)
  })

  it('does nothing where sessionStorage can\'t keep the guard: without it a failing page could loop', async () => {
    expect(await tab({ storage: null }).recover()).toBe(false)
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => {} }
    const t = tab({ storage: throwing })
    expect(await t.recover()).toBe(false)
    const full = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    const u = tab({ storage: full })
    expect(await u.recover()).toBe(false)
    expect(t.seen.reloads + u.seen.reloads).toBe(0)
  })

  it('does not reload a page the site can\'t replace: offline, or no answer from the site', async () => {
    const t = tab({ reachable: async () => false })
    expect(await t.recover()).toBe(false)
    expect(t.seen.reloads).toBe(0)
    expect(t.data.has(RELOAD_KEY)).toBe(false)
    const dead = tab({ reachable: async () => { throw new Error('network') } })
    expect(await dead.recover()).toBe(false)
  })

  it('does not reload a page that is held, and holding leaves the guard alone for a later failure', async () => {
    let busy = true
    const t = tab({ held: () => busy })
    expect(await t.recover()).toBe(false)
    expect(t.data.has(RELOAD_KEY)).toBe(false)
    busy = false
    expect(await t.recover()).toBe(true)
  })
})

describe('what holds a page', () => {
  it('holds while a phone is pairing or connected, and lets go when it leaves', () => {
    const remote = { status: 'ready' }
    const release = holdForPhone(remote)
    const seen: boolean[] = []
    for (const status of ['ready', 'connecting', 'connected', 'offline', 'ready']) { remote.status = status; seen.push(reloadHeld()) }
    expect(seen).toEqual([false, true, true, false, false])
    remote.status = 'connected'
    release()
    expect(reloadHeld()).toBe(false)
  })

  it('holds while any hold applies, and a hold that throws applies', () => {
    const a = holdReload(() => false)
    const b = holdReload(() => true)
    expect(reloadHeld()).toBe(true)
    b()
    expect(reloadHeld()).toBe(false)
    const c = holdReload(() => { throw new Error('gone') })
    expect(reloadHeld()).toBe(true)
    c()
    a()
    expect(reloadHeld()).toBe(false)
  })
})
