import { describe, expect, it } from 'vitest'
import {
  describeEnv, emptyTally, FAINT, keyInput, labelOf, mediaInput, padAxis, padButton, padName, sourceOf, summarize, trackWav, TRACKS,
} from '../src/buttons/inputs'

describe('Buttons diagnostic: an id for every physical input', () => {
  it('names the volume keys the same under every browser’s names and legacy key codes', () => {
    expect(keyInput({ key: 'AudioVolumeUp', code: 'AudioVolumeUp', keyCode: 175 })).toBe('key:AudioVolumeUp')
    // Gecko before the UI Events names, and a browser that gives only the legacy code
    expect(keyInput({ key: 'VolumeUp', code: '', keyCode: 0 })).toBe('key:AudioVolumeUp')
    expect(keyInput({ key: 'Unidentified', code: '', keyCode: 183 })).toBe('key:AudioVolumeUp')
    expect(keyInput({ key: 'Unidentified', code: '', keyCode: 174 })).toBe('key:AudioVolumeDown')
    expect(keyInput({ key: 'AudioVolumeMute', code: 'AudioVolumeMute', keyCode: 173 })).toBe('key:AudioVolumeMute')
    expect(sourceOf('key:AudioVolumeDown')).toBe('volume')
  })

  it('takes a key by its physical code, else its value, else its key code', () => {
    expect(keyInput({ key: 'q', code: 'KeyA', keyCode: 81 })).toBe('key:KeyA')
    expect(keyInput({ key: 'PageDown', code: 'PageDown', keyCode: 34 })).toBe('key:PageDown')
    expect(keyInput({ key: ' ', code: '', keyCode: 32 })).toBe('key:Space')
    expect(keyInput({ key: 'MediaPlayPause', code: 'Unidentified', keyCode: 179 })).toBe('key:MediaPlayPause')
    expect(keyInput({ key: 'Unidentified', code: '', keyCode: 0 })).toBe('key:#0')
    expect(sourceOf('key:Enter')).toBe('keys')
  })

  it('makes play and pause one press, and names pads by the standard mapping unless the browser doesn’t know it', () => {
    expect(mediaInput('play')).toBe('media:playpause')
    expect(mediaInput('pause')).toBe('media:playpause')
    expect(mediaInput('nexttrack')).toBe('media:nexttrack')
    expect(padButton(0, true)).toBe('pad:b0')
    expect(padButton(3, false)).toBe('pad:raw:b3')
    expect(padAxis(1, -1, true)).toBe('pad:a1-')
    expect(padAxis(2, 1, false)).toBe('pad:raw:a2+')
    expect(['media:nexttrack', 'pad:b0', 'pad:raw:a2+', 'back'].map(sourceOf)).toEqual(['media', 'pad', 'pad', 'back'])
  })
})

describe('Buttons diagnostic: badge labels', () => {
  it('fits a corner of a button', () => {
    const ids = ['key:AudioVolumeUp', 'key:AudioVolumeDown', 'key:Enter', 'key:Escape', 'key:ArrowRight', 'key:PageDown', 'key:KeyB', 'key:Digit5',
      'key:Numpad2', 'key:F5', 'key:#179', 'media:playpause', 'media:nexttrack', 'media:previoustrack', 'pad:b0', 'pad:b16', 'pad:b17',
      'pad:raw:b0', 'pad:a0-', 'pad:a3+', 'pad:raw:a1+', 'back']
    expect(ids.map(labelOf)).toEqual(['Vol+', 'Vol−', 'Enter', 'Esc', '→', 'PgDn', 'B', '5', 'Num2', 'F5', 'Key 179', 'Play', 'Next', 'Prev',
      'A', 'Home', 'B17', 'B0', 'L←', 'R↓', 'Axis 1+', 'Back'])
    for (const id of ids) expect(labelOf(id).length).toBeLessThanOrEqual(7)
  })

  it('takes the browser’s decoration off a pad’s name and keeps its USB ids', () => {
    expect(padName('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('Xbox Wireless Controller 045e:0b13')
    expect(padName('Razer Kishi V2 (Vendor: 1532 Product: 0717)')).toBe('Razer Kishi V2 1532:0717')
    expect(padName('45e-b13-Xbox Wireless Controller')).toBe('Xbox Wireless Controller 045e:0b13')
    expect(padName('DUALSENSE Wireless Controller Extended Gamepad')).toBe('DUALSENSE Wireless Controller Extended Gamepad')
    expect(padName('Backbone One (STANDARD GAMEPAD)')).toBe('Backbone One')
  })
})

describe('Buttons diagnostic: where the page runs', () => {
  const UA = {
    chrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    firefox: 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
    edge: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0',
    webview: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36',
    safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    crios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  }
  it('names the system, the browser and how the page is shown', () => {
    expect(describeEnv({ ua: UA.chrome, mode: 'browser' })).toBe('Android 10 · Chrome 141 · browser')
    // Chrome's reduced user agent says Android 10 and model K; the client hints say what it is
    expect(describeEnv({ ua: UA.chrome, platformVersion: '15.0.0', model: 'Pixel 8', mode: 'standalone' })).toBe('Android 15 · Pixel 8 · Chrome 141 · standalone')
    expect(describeEnv({ ua: UA.samsung, mode: 'browser' })).toBe('Android 14 · Samsung Internet 28 · browser')
    expect(describeEnv({ ua: UA.firefox, mode: 'browser' })).toBe('Android 15 · Firefox 143 · browser')
    expect(describeEnv({ ua: UA.edge, mode: 'twa' })).toBe('Android 10 · Edge 140 · twa')
    expect(describeEnv({ ua: UA.webview, mode: 'browser' })).toBe('Android 14 · WebView 140 · browser')
    expect(describeEnv({ ua: UA.safari, mode: 'home screen' })).toBe('iOS 26.0 · Safari 26.0 · home screen')
    expect(describeEnv({ ua: UA.crios, mode: 'browser' })).toBe('iOS 18.6 · Chrome 140 · browser')
    expect(describeEnv({ ua: UA.ipad, touch: true, mode: 'browser' })).toBe('iPadOS · Safari 26.0 · browser')
  })
})

describe('Buttons diagnostic: the line to paste back', () => {
  it('says what reached the page, by source, in the order it came', () => {
    const t = emptyTally('Android 15 · Pixel 8 · Chrome 141 · browser')
    t.inputs = { 'key:Enter': 2, 'key:AudioVolumeUp': 3, 'key:ArrowRight': 1, 'key:AudioVolumeDown': 1, 'media:playpause': 2, 'media:nexttrack': 1, 'pad:b0': 2, 'pad:b1': 1, back: 2 }
    t.volume = { hold: true, movedHeld: false }
    t.headset = 'on'
    t.hiddenMedia = true
    t.pads = ['Xbox Wireless Controller 045e:0b13 [standard, rumble ok (dual-rumble)]']
    t.back = { on: true, caught: 2, via: 'closewatcher' }
    t.fullscreen = true
    expect(summarize(t)).toBe('ob.Pal buttons 1 · Android 15 · Pixel 8 · Chrome 141 · browser | keys Enter×2 → | volume Vol+×3 Vol−, holding, held stayed'
      + ' | headset on 10s: Play×2 Next (while hidden too) | pad Xbox Wireless Controller 045e:0b13 [standard, rumble ok (dual-rumble)]: A×2 B'
      + ' | back 2 (closewatcher) | fullscreen')
  })

  it('says so when nothing came, and counts past ten per source', () => {
    expect(summarize(emptyTally('iOS 26.0 · Safari 26.0 · browser'))).toBe('ob.Pal buttons 1 · iOS 26.0 · Safari 26.0 · browser | keys none | volume none | headset off | pad none | back off')
    const t = emptyTally('x')
    for (let i = 0; i < 12; i++) t.inputs[`key:Digit${i % 10}${i >= 10 ? 'x' : ''}`] = 1
    t.headset = 'failed'
    expect(summarize(t)).toContain('keys 0 1 2 3 4 5 6 7 8 9 +2 | volume none | headset failed')
  })
})

describe('Buttons diagnostic: the headset test’s track', () => {
  const header = (b: Uint8Array) => {
    const v = new DataView(b.buffer)
    const text = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))
    return { tags: [text(0, 4), text(8, 4), text(12, 4), text(36, 4)], channels: v.getUint16(22, true), rate: v.getUint32(24, true), byteRate: v.getUint32(28, true), bits: v.getUint16(34, true), data: v.getUint32(40, true), riff: v.getUint32(4, true), v }
  }

  it('is a well-formed silent mono 8-bit WAV of the length asked for, every sample on the zero line', () => {
    const b = trackWav(10)
    const h = header(b)
    expect(h.tags).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect([h.channels, h.rate, h.byteRate, h.bits, h.data, h.riff]).toEqual([1, 8000, 8000, 8, 80000, b.length - 8])
    expect(b.subarray(44).every((x) => x === 128)).toBe(true)
  })

  it('makes the faint track 16-bit at a constant level over the -72 dBFS line and far below hearing', () => {
    const b = trackWav(10, true)
    const h = header(b)
    expect([h.bits, h.byteRate, h.data, h.riff]).toEqual([16, 16000, 160000, b.length - 8])
    for (const i of [0, 1234, 79999]) expect(h.v.getInt16(44 + i * 2, true)).toBe(FAINT)
    const dbfs = 20 * Math.log10(FAINT / 32768)
    expect(dbfs).toBeGreaterThan(-72.25)
    expect(dbfs).toBeLessThan(-60)
  })

  it('runs longer than the 5 s Chromium calls transient, except the 1 s the controller played', () => {
    expect(TRACKS['10s'].seconds).toBeGreaterThan(5)
    expect(TRACKS.faint.seconds).toBeGreaterThan(5)
    const t = emptyTally('x')
    t.headset = 'on'
    t.track = 'faint'
    expect(summarize(t)).toContain('| headset on 10s faint: none |')
  })
})
