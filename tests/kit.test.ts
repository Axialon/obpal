import { describe, expect, it } from 'vitest'
import { edge, fold, printable, step, Typeahead, typeahead } from '../src/ui/kit/listnav'
import { edgeSpot, freeSpans, placePopover } from '../src/ui/kit/place'
import { readSidebar, sidebarMode, writeSidebar } from '../src/ui/kit/sidebar'
import { nextStop, quantize, share, snapTo } from '../src/ui/kit/slider'
import { angleOf, arcPath, litDots, polar, valueOfAngle } from '../src/ui/kit/gauge'
import { dotLayout, dotPath, GLYPHS, glyphRows, sparkPath } from '../src/ui/kit/readout'
import { dismisses } from '../src/ui/kit/modal'
import { cardNumber } from '../src/ui/kit/card'
import { leadOf, parseReadout, sameShape, toneOf } from '../src/ui/kit/telemetry'

const list = (...off: boolean[]) => off.map((disabled) => ({ disabled }))

describe('moving through a list (the select, the segmented control, the tiles)', () => {
  it('finds the first and last enabled items, or none', () => {
    expect(edge(list(true, false, false, true), 'first')).toBe(1)
    expect(edge(list(true, false, false, true), 'last')).toBe(2)
    expect(edge(list(true, true), 'first')).toBe(-1)
    expect(edge([], 'last')).toBe(-1)
  })

  it('steps over disabled items and stops at the ends', () => {
    const items = list(false, true, false, false, true)
    expect(step(items, 0, 1)).toBe(2)
    expect(step(items, 2, -1)).toBe(0)
    expect(step(items, 3, 1)).toBe(3)
    expect(step(items, 0, -1)).toBe(0)
  })

  it('starts from the right end when nothing is active', () => {
    const items = list(true, false, false, true)
    expect(step(items, -1, 1)).toBe(1)
    expect(step(items, -1, -1)).toBe(2)
    expect(step([], -1, 1)).toBe(-1)
  })

  it('jumps a page at a time, landing on the nearest enabled item and never past the end', () => {
    const items = list(...Array.from({ length: 25 }, (_, i) => i === 10 || i === 24))
    expect(step(items, 0, 1, { count: 10 })).toBe(11)
    expect(step(items, 20, 1, { count: 10 })).toBe(23)
    expect(step(items, 23, -1, { count: 10 })).toBe(13)
    expect(step(items, 3, -1, { count: 10 })).toBe(0)
  })

  it('goes round when asked to (radio groups), and stays put when it is the only enabled item', () => {
    const items = list(false, true, false)
    expect(step(items, 2, 1, { wrap: true })).toBe(0)
    expect(step(items, 0, -1, { wrap: true })).toBe(2)
    expect(step(list(true, false, true), 1, 1, { wrap: true })).toBe(1)
  })
})

describe('type-ahead', () => {
  const labels = ['All controllers', 'Gamepad', 'Wheel', 'Wii', 'Mouse', 'Trackpad', '3D hand', 'Keyboard', 'Drums', 'Keys']

  it('jumps to the first label that starts with what was typed, ignoring case and accents', () => {
    expect(typeahead(labels, 'tr', 0)).toBe(5)
    expect(typeahead(labels, 'TRACK', 0)).toBe(5)
    expect(typeahead(labels, '3d', 0)).toBe(6)
    expect(typeahead(['Crème', 'Creek'], 'creme', -1)).toBe(0)
    expect(fold('  Pâte  à Sel ')).toBe('pate a sel')
  })

  it('cycles through the labels that start with a letter typed again and again', () => {
    expect(typeahead(labels, 'w', 0)).toBe(2)
    expect(typeahead(labels, 'w', 2)).toBe(3)
    expect(typeahead(labels, 'ww', 3)).toBe(2)
    expect(typeahead(labels, 'k', 7)).toBe(9)
    expect(typeahead(labels, 'k', 9)).toBe(7)
  })

  it('keeps the current item while a longer query still matches it', () => {
    expect(typeahead(labels, 'ke', 7)).toBe(7)
    expect(typeahead(labels, 'key', 7)).toBe(7)
    expect(typeahead(labels, 'keys', 7)).toBe(9)
  })

  it('passes over disabled items, and finds nothing for no match', () => {
    const off = labels.map((l) => l === 'Wheel')
    expect(typeahead(labels, 'w', 0, off)).toBe(3)
    expect(typeahead(labels, 'zz', 0)).toBe(-1)
    expect(typeahead(labels, '', 0)).toBe(-1)
  })

  it('builds one query from keys typed close together, and starts again after a pause', () => {
    const t = new Typeahead(500)
    expect(t.push('t', 0)).toBe('t')
    expect(t.push('r', 200)).toBe('tr')
    expect(t.typing(600)).toBe(true)
    expect(t.typing(701)).toBe(false)
    expect(t.push('g', 900)).toBe('g')
    t.reset()
    expect(t.typing(900)).toBe(false)
  })

  it('counts only characters typed without Ctrl, Alt or Meta as type-ahead', () => {
    expect(printable({ key: 'a' })).toBe(true)
    expect(printable({ key: ' ' })).toBe(true)
    expect(printable({ key: 'a', ctrlKey: true })).toBe(false)
    expect(printable({ key: 'ArrowDown' })).toBe(false)
  })
})

describe('placing a popover', () => {
  const view = { width: 1440, height: 900 }
  it('opens below its button, its edge on the button’s, with the room below as its limit', () => {
    const at = placePopover({ left: 24, top: 100, width: 246, height: 40 }, { width: 246, height: 400 }, view)
    expect(at).toEqual({ left: 24, top: 146, maxHeight: 900 - 8 - 146, side: 'below' })
  })

  it('opens above when the room below is short and there is more above', () => {
    const at = placePopover({ left: 24, top: 780, width: 246, height: 40 }, { width: 246, height: 420 }, view)
    expect(at.side).toBe('above')
    expect(at.top).toBe(780 - 6 - 420)
    expect(at.maxHeight).toBe(780 - 6 - 8)
  })

  it('stays inside the frame sideways, and aligns to the button’s end on request', () => {
    expect(placePopover({ left: 1400, top: 10, width: 30, height: 30 }, { width: 240, height: 100 }, view).left).toBe(1440 - 8 - 240)
    expect(placePopover({ left: 600, top: 10, width: 100, height: 30 }, { width: 240, height: 100 }, view, { align: 'end' }).left).toBe(460)
  })

  it('beside a rail: to its right when there is room, else its left, level with the button and inside the frame', () => {
    const right = placePopover({ left: 12, top: 800, width: 76, height: 48 }, { width: 260, height: 420 }, view, { beside: true, gap: 10 })
    expect(right).toMatchObject({ side: 'right', left: 98, top: 900 - 8 - 420 })
    const left = placePopover({ left: 1300, top: 100, width: 76, height: 48 }, { width: 260, height: 200 }, view, { beside: true })
    expect(left).toMatchObject({ side: 'left', left: 1300 - 6 - 260, top: 100 })
  })
})

describe('a place on a screen edge (the quick-actions tray)', () => {
  it('sits where it would like to be when nothing is in the way', () => {
    expect(edgeSpot(450, 300, 84, 892, [])).toBe(450)
  })
  it('keeps all of itself inside the edge it has', () => {
    expect(edgeSpot(100, 300, 84, 892, [])).toBe(84 + 150)
    expect(edgeSpot(880, 300, 84, 892, [])).toBe(892 - 150)
  })
  it('moves just clear of what is in the way: above the pairing card, below a toolbar', () => {
    // A pairing card from 460 down: the tray ends where the card starts.
    expect(edgeSpot(450, 300, 84, 892, [[460, 892]])).toBe(460 - 150)
    // A toolbar at the top, and the card: the room between them.
    expect(edgeSpot(300, 200, 84, 892, [[84, 140], [600, 892]])).toBe(300)
    expect(edgeSpot(300, 200, 84, 892, [[84, 260], [600, 892]])).toBe(360)
  })
  it('takes the clear stretch nearest where it would like to be', () => {
    // Room above and below a window in the middle: the nearer side wins.
    expect(edgeSpot(500, 100, 0, 1000, [[300, 580]])).toBe(630)
    expect(edgeSpot(400, 100, 0, 1000, [[300, 580]])).toBe(250)
  })
  it('stays where it would like to be when nowhere is clear, inside the edge', () => {
    expect(edgeSpot(450, 300, 84, 892, [[84, 892]])).toBe(450)
    expect(edgeSpot(450, 900, 84, 892, [])).toBe(84 + 450)
  })
  it('finds the clear stretches, however the blocked ones overlap or run past the ends', () => {
    expect(freeSpans(0, 100, [])).toEqual([[0, 100]])
    expect(freeSpans(0, 100, [[60, 80], [10, 30], [25, 40]])).toEqual([[0, 10], [40, 60], [80, 100]])
    expect(freeSpans(20, 100, [[0, 30], [90, 140]])).toEqual([[30, 90]])
    expect(freeSpans(0, 100, [[0, 100]])).toEqual([])
  })
})

describe('the sidebar', () => {
  it('is docked on a computer, a drawer on a tablet, and a sheet on a phone either way up', () => {
    expect(sidebarMode(1920, 1080)).toBe('docked')
    expect(sidebarMode(1440, 900)).toBe('docked')
    expect(sidebarMode(1200, 800)).toBe('docked')
    expect(sidebarMode(1199, 800)).toBe('drawer')
    expect(sidebarMode(1024, 768)).toBe('drawer')
    expect(sidebarMode(768, 1024)).toBe('drawer')
    expect(sidebarMode(700, 900)).toBe('sheet')
    expect(sidebarMode(390, 844)).toBe('sheet')
    expect(sidebarMode(844, 390)).toBe('sheet')
    expect(sidebarMode(1400, 500)).toBe('sheet')
  })

  it('remembers whether it was folded, and forgets gracefully where storage fails', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
    expect(readSidebar('side', store)).toBe('expanded')
    writeSidebar('side', 'collapsed', store)
    expect(readSidebar('side', store)).toBe('collapsed')
    writeSidebar('side', 'expanded', store)
    expect(readSidebar('side', store)).toBe('expanded')
    data.set('side', 'sideways')
    expect(readSidebar('side', store)).toBe('expanded')
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(readSidebar('side', broken)).toBe('expanded')
    expect(() => writeSidebar('side', 'collapsed', broken)).not.toThrow()
    expect(readSidebar('side', null)).toBe('expanded')
  })
})

describe('the slider with detents', () => {
  it('clamps and rounds to whole steps from its minimum', () => {
    expect(quantize(0.537, 0, 1, 0.1)).toBe(0.5)
    expect(quantize(7, 0, 5, 1)).toBe(5)
    expect(quantize(-2, 0, 5, 1)).toBe(0)
    expect(quantize(1.26, 0.25, 3, 0.25)).toBe(1.25)
    expect(quantize(0.3, 0, 1, 0)).toBe(0.3)
  })

  it('settles into the nearest stop within reach, and nowhere else', () => {
    const stops = [0, 1, 2]
    expect(snapTo(1.08, stops, 0.1)).toBe(1)
    expect(snapTo(0.93, stops, 0.1)).toBe(1)
    expect(snapTo(1.4, stops, 0.1)).toBe(1.4)
    expect(snapTo(1.95, stops, 0.1)).toBe(2)
  })

  it('jumps from stop to stop with Page Up and Page Down', () => {
    const stops = [2, 0, 1]
    expect(nextStop(0.4, stops, 1)).toBe(1)
    expect(nextStop(1, stops, 1)).toBe(2)
    expect(nextStop(2, stops, 1)).toBe(2)
    expect(nextStop(1, stops, -1)).toBe(0)
    expect(nextStop(0, stops, -1)).toBe(0)
  })

  it('fills its share of the track', () => {
    expect(share(1, 0, 2)).toBe(0.5)
    expect(share(-1, 0, 2)).toBe(0)
    expect(share(3, 0, 2)).toBe(1)
    expect(share(1, 1, 1)).toBe(0)
  })
})

describe('the ring gauge and dial', () => {
  it('measures angles clockwise from twelve o’clock', () => {
    const at = (deg: number) => polar(50, 50, 10, deg).map((v) => Math.round(v * 1000) / 1000)
    expect(at(0)).toEqual([50, 40])
    expect(at(90)).toEqual([60, 50])
    expect(at(180)).toEqual([50, 60])
    expect(at(-90)).toEqual([40, 50])
  })

  it('draws arcs, the long way round with the large-arc flag, and a whole ring as two halves', () => {
    expect(arcPath(50, 50, 10, 0, 90)).toBe('M50 40 A10 10 0 0 1 60 50')
    expect(arcPath(50, 50, 10, -135, 135)).toMatch(/ 0 1 1 /)
    expect(arcPath(50, 50, 10, 30, 30)).toBe('')
    const ring = arcPath(50, 50, 10, 0, 360)
    expect(ring.match(/A/g)).toHaveLength(2)
    expect(ring.match(/M/g)).toHaveLength(1)
  })

  it('turns values into angles and back across its sweep', () => {
    expect(angleOf(0, -135, 135, -135, 270)).toBe(0)
    expect(angleOf(135, -135, 135, -135, 270)).toBe(135)
    expect(angleOf(999, 0, 1, -135, 270)).toBe(135)
    expect(valueOfAngle(0, 0, 100, -135, 270)).toBe(50)
    expect(valueOfAngle(90, 0, 100, -135, 270)).toBeCloseTo(83.33, 2)
    expect(valueOfAngle(-90, 0, 100, -135, 270)).toBeCloseTo(16.67, 2)
  })

  it('reads a dial turned into the gap past its ends as the nearer end', () => {
    expect(valueOfAngle(170, 0, 100, -135, 270)).toBe(100)
    expect(valueOfAngle(-170, 0, 100, -135, 270)).toBe(0)
    expect(valueOfAngle(359, 0, 1, 0, 360)).toBeCloseTo(359 / 360, 5)
  })

  it('lights its share of dots', () => {
    expect(litDots(48, 0.5)).toBe(24)
    expect(litDots(48, 0)).toBe(0)
    expect(litDots(48, 1.2)).toBe(48)
  })
})

describe('the dot-matrix readout', () => {
  it('has a 5×7 glyph for every digit and capital, and blanks what it doesn’t know', () => {
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const rows = GLYPHS[ch]
      expect(rows, ch).toHaveLength(7)
      expect(rows.every((r) => r >= 0 && r < 32), ch).toBe(true)
      expect(rows.some((r) => r > 0), ch).toBe(true)
    }
    expect(glyphRows('k')).toBe(GLYPHS.K)
    expect(glyphRows('€').every((r) => r === 0)).toBe(true)
  })

  it('keeps digits five dots wide, gives punctuation only the columns it lights, and a dark column between', () => {
    expect(dotLayout('88').cols).toBe(11)
    expect(dotLayout('1.5').cols).toBe(5 + 1 + 2 + 1 + 5)
    const one = dotLayout('1')
    expect(one.lit.length + one.dark.length).toBe(35)
    expect(one.lit.length).toBe(10)
    expect(dotLayout('').cols).toBe(0)
  })

  it('draws its dots as one path of circles', () => {
    const d = dotPath([[0, 0], [2, 3]], 4, 1.5)
    expect(d.match(/M/g)).toHaveLength(2)
    expect(d.startsWith('M0.5 2a1.5 1.5 0 1 0 3 0')).toBe(true)
  })

  it('draws a sparkline across its box, its last point marked', () => {
    const { d, last } = sparkPath([0, 5, 10], 100, 20, 2)
    expect(d).toBe('M2 18L50 10L98 2')
    expect(last).toEqual([98, 2])
    expect(sparkPath([3], 100, 20, 2).last).toEqual([50, 18])
    expect(sparkPath([], 100, 20).d).toBe('')
  })
})

describe('drawers, sheets and cards', () => {
  it('dismisses a sheet dragged a third of its depth toward its edge, or flicked there', () => {
    expect(dismisses(150, 400, 0.1)).toBe(true)
    expect(dismisses(100, 400, 0.1)).toBe(false)
    expect(dismisses(40, 400, 0.9)).toBe(true)
    expect(dismisses(10, 400, 2)).toBe(false)
    expect(dismisses(-200, 400, 1)).toBe(false)
  })

  it('numbers widget cards with two digits', () => {
    expect(cardNumber(1)).toBe('01')
    expect(cardNumber(12)).toBe('12')
    expect(cardNumber(104)).toBe('104')
  })
})

describe('telemetry: a device readout read as an instrument', () => {
  it('reads measurements, ranks, labelled values, fractions, shares, quotes and words', () => {
    expect(parseReadout('#2 · 3 laps · gate 2/8 · 42 km/h')).toEqual([
      { kind: 'metric', value: '#2', unit: 'place', label: '' },
      { kind: 'metric', value: '3', unit: 'laps', label: '' },
      { kind: 'ratio', a: 2, b: 8, label: 'gate' },
      { kind: 'metric', value: '42', unit: 'km/h', label: '' },
    ])
    expect(parseReadout('78% open')).toEqual([{ kind: 'percent', value: 0.78, label: 'open' }])
    expect(parseReadout('21.5 °C · set 21 °C')).toEqual([
      { kind: 'metric', value: '21.5', unit: '°C', label: '' },
      { kind: 'metric', value: '21', unit: '°C', label: 'set' },
    ])
    expect(parseReadout('-3.5° · buoy 2')).toEqual([
      { kind: 'metric', value: '-3.5', unit: '°', label: '' },
      { kind: 'metric', value: '2', unit: '', label: 'buoy' },
    ])
    expect(parseReadout('1.2 m · 3/6 keys · 3.2 / 12 s')[2]).toEqual({ kind: 'ratio', a: 3.2, b: 12, label: 's' })
    expect(parseReadout('“hello there”')).toEqual([{ kind: 'quote', text: 'hello there' }])
    expect(parseReadout('Landed · 3 rings')[0]).toEqual({ kind: 'status', text: 'Landed', tone: 'idle' })
    expect(parseReadout('2.4 m head · REC 3.2 s')[1]).toEqual({ kind: 'metric', value: '3.2', unit: 's', label: 'REC' })
    expect(parseReadout('')).toEqual([])
  })

  it('tones words for their status dot', () => {
    expect(toneOf('Recording')).toBe('rec')
    expect(toneOf('Off track')).toBe('warn')
    expect(toneOf('Ready')).toBe('idle')
    expect(toneOf('charging')).toBe('ok')
    expect(toneOf('in play')).toBe('live')
  })

  it('leads with the first measurement, else a gauge, else words', () => {
    expect(leadOf(parseReadout('Landed · 3 rings'))).toBe(1)
    expect(leadOf(parseReadout('Fan off'))).toBe(0)
    expect(leadOf(parseReadout('Holding · 3/5 wrecks'))).toBe(1)
    expect(leadOf([])).toBe(-1)
  })

  it('updates in place while a readout keeps its shape, and rebuilds when it changes', () => {
    expect(sameShape(parseReadout('12 km/h'), parseReadout('13 km/h'))).toBe(true)
    expect(sameShape(parseReadout('Landed'), parseReadout('1.2 m · 0 rings'))).toBe(false)
    expect(sameShape(parseReadout('best 12 s'), parseReadout('12 s'))).toBe(false)
  })
})
