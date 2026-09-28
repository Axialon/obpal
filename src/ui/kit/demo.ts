/**
 * The kit's components sheet: every control in its states, and a few widget cards made of them, as the sims' panels
 * will use them. It's a review page, loaded only when /sim/ is opened with ?kit=sheet.
 */
import { html, setMarkup } from '../markup'
import { ICONS } from '../icons'
import { GlassSelect } from './select'
import { Segmented } from './segmented'
import { DetentSlider } from './slider'
import { toggle } from './toggle'
import { CapsuleGauge, RingGauge } from './gauge'
import { Readout, Sparkline } from './readout'
import { Telemetry } from './telemetry'
import { statusDot } from './status'
import { widgetCard } from './card'
import { Sheet } from './sheet'
import '../../styles/kit-demo.css'

const FACES: [string, string, number][] = [['', 'All controllers', 41], ['gamepad', 'Gamepad', 33], ['wheel', 'Wheel', 4], ['point', 'Wii', 14], ['mouse', 'Mouse', 4], ['drag', 'Trackpad', 38], ['cube', '3D hand', 12], ['keyboard', 'Keyboard', 1], ['drum', 'Drums', 1], ['piano', 'Keys', 1]]
const div = (cls: string, ...kids: (Node | string)[]) => { const d = document.createElement('div'); d.className = cls; d.append(...kids); return d }
const caption = (text: string) => { const s = document.createElement('small'); s.className = 'kd-cap'; s.textContent = text; return s }

/** A static sidebar in both its states, as markup the Sidebar lays out. */
function sidebarPair() {
  const side = (state: 'expanded' | 'collapsed') => {
    const el = document.createElement('div')
    el.className = 'kit-side kd-side'
    el.dataset.mode = 'docked'
    el.dataset.state = state
    const items: [string, string, number, boolean][] = [['models', 'All', 41, false], ['arm', 'Robotics', 7, true], ['drone', 'Flying', 3, false], ['camera', 'Camera and stage', 6, false]]
    setMarkup(el, html`<div class="kit-side-body"><p class="kit-side-label"><b>02</b> Categories</p><ul class="kit-side-list">${items.map(([icon, name, n, on]) => html`<li><button type="button" class="kit-side-item" aria-pressed="${on ? 'true' : 'false'}"><span class="kit-side-ic" aria-hidden="true">${ICONS[icon]}</span><span class="kit-side-text">${name}</span><span class="kit-side-n">${n}</span></button></li>`)}</ul></div>`)
    return el
  }
  return div('kd-row kd-top', side('expanded'), side('collapsed'))
}

export function mountSheet() {
  document.querySelector<HTMLElement>('.sims-app')!.hidden = true
  const main = document.createElement('main')
  main.className = 'kd'
  setMarkup(main, html`<header class="kd-head"><p class="kd-eyebrow">ob.Pal · UI system</p><h1>The glass kit. <span>Every control, one family.</span></h1><p>Lime on Carbon, frosted glass, rounded corners, hairline edges. Keyboard, touch, focus rings and reduced motion throughout.</p></header><div class="kd-grid"></div>`)
  const grid = main.querySelector('.kd-grid')!
  const card = (n: number, title: string, body: Node[], wide = false) => {
    const c = widgetCard({ n, title, body })
    if (wide) c.classList.add('kd-wide')
    grid.append(c)
    return c
  }

  // 01 The glass select: closed, chosen, disabled; one opens at the end.
  const items = FACES.map(([icon, label, n]) => ({ value: icon, label, icon: ICONS[icon || 'phone'], badge: n, disabled: n === 1 && icon === 'keyboard' }))
  const chosen = new GlassSelect({ label: 'Controller', items, value: 'point' })
  const plain = new GlassSelect({ label: 'Kind of arm', items: ['Five-axis arm', 'SO-101', 'SCARA', 'Delta'].map((v) => ({ value: v, label: v })), value: 'SCARA' })
  const off = new GlassSelect({ label: 'Speed', items: [{ value: '25', label: '25%' }], value: '25' })
  off.disabled = true
  const opened = new GlassSelect({ label: 'Controller', items, value: 'drag' })
  const select = card(1, 'Glass select', [div('kd-stack', chosen.button, plain.button, off.button, opened.button), caption('Icons, counts, groups and type-ahead; never the system list')])

  // 02 The sidebar and its rail.
  card(2, 'Sidebar and rail', [sidebarPair(), caption('The chosen item wears the accent ring; the rail keeps names as tooltips')], true)

  // 03 Segmented controls and tiles.
  const modes = new Segmented({ label: 'Mode', iconOnly: true, value: 'drag', items: [['point', 'Point'], ['tilt', 'Tilt'], ['drag', 'Drag'], ['gamepad', 'Gamepad'], ['cube', '3D hand']].map(([icon, label]) => ({ value: icon, label, icon: ICONS[icon] })) })
  const words = new Segmented({ label: 'Layout', value: 'kit', items: [{ value: 'kit', label: 'Kit', icon: ICONS.drum }, { value: 'hand', label: 'Hand drums', icon: ICONS.tap }] })
  const seats = new Segmented({ label: 'Seat', tiles: true, value: '2', items: [['1', 'Rover 1', 'car'], ['2', 'Rover 2', 'car'], ['3', 'Drone', 'drone'], ['4', 'Arm', 'arm']].map(([value, label, icon], i) => ({ value, label, icon: ICONS[icon], badge: i === 1 ? 'You' : i === 3 ? 'Free' : 'Taken', disabled: i === 0 })) })
  card(3, 'Segmented and tiles', [div('kd-stack', modes.el, words.el), seats.el])

  // 04 Sliders with detents.
  const speed = new DetentSlider({ label: 'Speed', min: 0, max: 2, step: 0.01, value: 1, detents: [{ value: 0, label: 'Slow' }, { value: 1, label: 'Regular' }, { value: 2, label: 'Max' }] })
  const light = new DetentSlider({ label: 'Light', min: 0, max: 3, step: 1, value: 2, vertical: true, detents: [{ value: 0, label: 'Off' }, { value: 1, label: 'Side' }, { value: 2, label: 'Bottom' }, { value: 3, label: 'Both' }] })
  card(4, 'Slider with detents', [div('kd-row', div('kd-grow', speed.el), light.el)])

  // 05 Toggles.
  const t3 = toggle({ label: 'Grip lock', checked: true })
  t3.querySelector('input')!.disabled = true
  card(5, 'Toggle', [div('kd-stack', toggle({ label: 'Horizon lock', checked: true }), toggle({ label: 'Comfort shade' }), t3)])

  // 06 Ring gauges and the dial.
  const joint = new RingGauge({ label: 'Elbow', value: 72, min: -135, max: 135, format: (v) => `${Math.round(v)}°`, caption: 'Elbow', size: 116 })
  const devices = new RingGauge({ label: 'Devices', value: 0.82, kind: 'dots', sweep: 360, start: 0, dots: 56, format: () => '128', caption: 'Devices', size: 116 })
  const dial = new RingGauge({ label: 'Wrist', value: 40, min: 0, max: 180, interactive: true, step: 1, format: (v) => `${Math.round(v)}°`, caption: 'Wrist · turn', size: 116 })
  card(6, 'Ring gauge and dial', [div('kd-row kd-around', joint.el, devices.el, dial.el)], true)

  // 07 Capsule gauges.
  card(7, 'Capsule gauge', [div('kd-row kd-around', new CapsuleGauge({ label: 'Battery', value: 0.31, vertical: true }).el, div('kd-stack', new CapsuleGauge({ label: 'Charge', value: 0.78 }).el, new CapsuleGauge({ label: 'Fuel', value: 0.12 }).el))])

  // 08 Dot-matrix readouts and sparklines.
  const tokens = new Readout({ value: '12.4K', unit: 'Tokens', pitch: 5 })
  const angle = new Readout({ value: '-3.5°', unit: 'Pitch', pitch: 4 })
  const rec = new Readout({ value: 'REC', pitch: 3 })
  rec.el.dataset.tone = 'ink'
  const spark = new Sparkline({ label: 'Altitude, last minute', values: [3, 4, 3.6, 5, 4.6, 6, 5.4, 7.2, 6.8, 8, 7.4, 9], width: 160, height: 36 })
  card(8, 'Readouts', [div('kd-stack', tokens.el, div('kd-row', angle.el, rec.el), spark.el)])

  // 09 Status dots.
  card(9, 'Status dots', [div('kd-stack', statusDot('live', 'Live'), statusDot('ok', 'Connected'), statusDot('warn', 'At its limit'), statusDot('bad', 'Stopped'), statusDot('idle', 'Free'), statusDot('rec', 'Rec'))])

  // 10 to 12 Widget cards made of the parts, as the sims' panels will be.
  const arm = new RingGauge({ label: 'Shoulder', value: 18, min: -90, max: 90, format: (v) => `${Math.round(v)}°`, caption: 'Shoulder', size: 104 })
  const reach = new Readout({ value: '74', unit: 'cm reach', pitch: 4 })
  card(10, 'Arm 1 · joints', [div('kd-row', arm.el, div('kd-stack', reach.el, statusDot('live', 'Held · Player 2'), new CapsuleGauge({ label: 'Gripper', value: 1 }).el))]).querySelector('.kit-card-head')!.append(statusDot('live'))
  const alt = new Readout({ value: '2.40', unit: 'm alt', pitch: 4 })
  const speedR = new Readout({ value: '1.8', unit: 'm/s', pitch: 4 })
  card(11, 'Drone · telemetry', [div('kd-row', alt.el, speedR.el), new Sparkline({ label: 'Altitude', values: [0, 0.4, 1.1, 1.8, 2.2, 2.5, 2.4, 2.38, 2.41, 2.4], width: 220, height: 40 }).el, div('kd-row kd-between', new CapsuleGauge({ label: 'Battery', value: 0.64 }).el, statusDot('ok', 'Hover')), div('kd-row kd-between', new Telemetry('2.4 m up · 3/8 rings · Flying').el, new Telemetry('1.4× · 12 shots').el)])
  const view = div('kd-feed kit-brackets')
  view.append(div('kd-feed-rec', statusDot('rec', 'Rec')), div('kd-feed-cap', 'CAM 2 · 35 mm'))
  card(12, 'Camera · feed', [view])

  // 13 Chips and the call to action.
  const cta = document.createElement('button')
  cta.type = 'button'
  cta.className = 'kit-cta'
  setMarkup(cta, html`<span>Show 33 sims</span>${ICONS['arrow-right']}`)
  const chips = div('kd-row kd-wrap')
  for (const [icon, text] of [['arm', 'Robotics'], ['gamepad', 'Gamepad'], ['search', '“harbour”']]) {
    const c = document.createElement('span')
    c.className = 'kit-chip'
    setMarkup(c, html`${ICONS[icon]}<span>${text}</span><button type="button" aria-label="Remove">${ICONS.close}</button>`)
    chips.append(c)
  }
  // The standalone sheet, as a sim's panel will open one on a phone.
  const sheet = new Sheet({ title: 'Seat 2 · Rover' })
  sheet.body.append(new Segmented({ label: 'Drive', value: 'wheel', items: [['wheel', 'Wheel'], ['gamepad', 'Gamepad'], ['drag', 'Trackpad']].map(([icon, label]) => ({ value: icon, label, icon: ICONS[icon] })) }).el)
  const done = document.createElement('button')
  done.type = 'button'
  done.className = 'kit-cta'
  setMarkup(done, html`<span>Take the seat</span>${ICONS['arrow-right']}`)
  done.onclick = () => sheet.close()
  sheet.footer.append(done)
  const openSheet = document.createElement('button')
  openSheet.type = 'button'
  openSheet.className = 'kit-chip'
  openSheet.textContent = 'Open a sheet'
  openSheet.onclick = () => sheet.open(openSheet)
  card(13, 'Chips and the call to action', [chips, cta, openSheet])

  document.body.append(main)
  // A specimen of the list, open and in place in its card rather than over the others.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    opened.open()
    opened.list.classList.add('kd-static')
    select.querySelector('.kit-card-body')!.append(opened.list)
    document.documentElement.dataset.kitSheet = 'ready'
  }))
}
