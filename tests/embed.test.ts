import { describe, expect, it } from 'vitest'
import { Mode, withControllers } from '../packages/core/src/index'
import { embedLayout, parseCorner, parseFlag, parseModes, parseScheme, parseSeats } from '../packages/host/src/embed-attrs'
import { DEFAULT_LAYOUT } from '../packages/host/src/remote'

describe('<obpal-remote modes>: mode names and catalogue controller ids (PLAN §10 step 3)', () => {
  it('reads controller ids as controllers, with the modes older phones need, in order', () => {
    expect(parseModes('face.wii face.trackpad')).toEqual({ modes: [Mode.point, Mode.tilt, Mode.hold], controllers: ['face.wii', 'face.trackpad'], unknown: [] })
    expect(parseModes('face.gamepad')).toEqual({ modes: [Mode.gamepad], controllers: ['face.gamepad'], unknown: [] })
  })

  it('reads mode names as modes, with the controller each stands for', () => {
    expect(parseModes('point hold')).toEqual({ modes: [Mode.point, Mode.hold], controllers: ['face.wii', 'face.trackpad'], unknown: [] })
    // Tilt and hold are both the trackpad: one controller, both modes.
    expect(parseModes('tilt, hold, gamepad, track')).toEqual({ modes: [Mode.tilt, Mode.hold, Mode.gamepad, Mode.track], controllers: ['face.trackpad', 'face.gamepad', 'face.hand'], unknown: [] })
  })

  it('mixes both, keeps each once, takes any case and separator, and names what it doesn’t know', () => {
    expect(parseModes(' Hold,face.WII  face.wii\tface.hand, jetpack toString ')).toEqual({
      modes: [Mode.hold, Mode.point, Mode.track], controllers: ['face.trackpad', 'face.wii', 'face.hand'], unknown: ['jetpack', 'toString'],
    })
  })

  it('is absent when the attribute is', () => {
    expect(parseModes(null)).toBeNull()
    expect(parseModes('')).toBeNull()
    expect(parseModes('  , ')).toBeNull()
  })
})

describe('the layout the element offers', () => {
  it('without modes, offers what the SDK does by default', () => {
    expect(embedLayout({})).toEqual({ v: 1, tray: [], modes: DEFAULT_LAYOUT.modes })
  })

  it('carries the modes, the controllers and the profile, and the page’s own fields over them', () => {
    const tray = [{ id: 'reset', label: 'Reset' }]
    expect(embedLayout({ modes: 'face.wheel', profile: ' flight ' }, { tray, toss: true })).toEqual({
      v: 1, tray, toss: true, modes: [Mode.gamepad], controllers: ['face.wheel'], profile: 'flight',
    })
    // The page's layout wins where both say something.
    expect(embedLayout({ modes: 'point', profile: 'flight' }, { modes: [Mode.hold], profile: 'driving' })).toMatchObject({ modes: [Mode.hold], profile: 'driving' })
  })

  it('is what every phone reads once the SDK fills it in: the mouse, the keyboard, the wheel’s profile', () => {
    const l = withControllers(embedLayout({ modes: 'face.mouse face.keyboard' }))
    expect(l.modes).toEqual([Mode.point])
    expect(l.point).toBe('mouse')
    expect(l.tray.map((c) => c.type)).toEqual(['keyboard'])
    expect(withControllers(embedLayout({ modes: 'face.wheel' })).profile).toBe('driving')
  })
})

describe('the other attributes', () => {
  it('seats: 1 to 8, 1 when absent or not a number', () => {
    expect([null, '', 'x', '0', '1', '4', '4.7', '12', '-3'].map(parseSeats)).toEqual([1, 1, 1, 1, 1, 4, 4, 8, 1])
  })

  it('corner: the four corners or inline, else bottom-right', () => {
    expect(['top-left', 'TOP-RIGHT', 'bottom-left', 'inline', 'middle', null].map(parseCorner)).toEqual(['top-left', 'top-right', 'bottom-left', 'inline', 'bottom-right', 'bottom-right'])
  })

  it('scheme: light, dark or auto', () => {
    expect(['light', 'Dark', 'sepia', null].map(parseScheme)).toEqual(['light', 'dark', 'auto', 'auto'])
  })

  it('a yes-or-no attribute: present is yes unless it says no', () => {
    expect(parseFlag(null, true)).toBe(true)
    expect(parseFlag(null, false)).toBe(false)
    expect(['', 'true', 'yes', 'test-link'].map((t) => parseFlag(t, false))).toEqual([true, true, true, true])
    expect(['false', 'OFF', 'no', '0', ' 0 '].map((t) => parseFlag(t, true))).toEqual([false, false, false, false, false])
  })
})
