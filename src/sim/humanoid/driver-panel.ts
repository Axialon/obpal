/** Explicit, simulated-driver controls. All leases come from a locally held physical control. */
import { html, setMarkup } from '../../ui/markup'
import { dotLoading } from '../../ui/kit/loading'
import { iconAction } from '../../ui/kit/action'
import { GlassSelect } from '../../ui/kit/select'
import { DetentSlider } from '../../ui/kit/slider'
import { fitControlInk } from '../../ui/kit/ink'
import type { Panels } from '../ui/panels'
import { DriverFigure } from './driver-figure'
import { fakeProfile, legRefusal, upperJoints, type DriverKind } from './driver-profile'
import { simulatedDriver, type FakeRosbridge } from './fake-drivers'
import { TIMING } from './drivers'
import { LiveSession } from './live'
import type { TargetInput } from './safety'

export class DriverPanel {
  private footerSize: ResizeObserver
  readonly session = new LiveSession()
  readonly el = document.createElement('div')
  readonly panel
  transport: FakeRosbridge | null = null
  private figure = new DriverFigure()
  private source: 'jog' | 'body' = 'jog'
  private inputOwner = ''
  private padReleased = true
  private wasVisible = false
  private timer: ReturnType<typeof setInterval>
  private lastDraw = 0
  private connecting = false
  constructor(
    panels: Panels,
    private body: () => TargetInput,
    camera: () => void,
  ) {
    this.el.className = 'humanoid-driver'
    setMarkup(
      this.el,
      html` <p class="driver-disclaimer">Tested against simulated drivers only.</p>
        <div class="driver-overview">
          <div data-twin></div>
          <div>
            <span class="driver-eyebrow">Measured twin</span>
            <h3 data-state>Disconnected</h3>
            <p data-reason role="status" aria-live="polite"></p>
          </div>
        </div>
        <div class="driver-row" data-connection>
          <button class="kit-action" data-connect type="button"></button>
          <button class="kit-action" data-disconnect type="button"></button>
        </div>
        <details data-checklist>
          <summary>Go-live checklist <span data-check-count></span></summary>
          <ul class="driver-checks" data-checks></ul>
          <label class="sim-auto" title="Joint map verified"
            ><input type="checkbox" data-mapping aria-label="Joint map verified" />Map checked</label
          >
          <label class="sim-auto" title="Workspace clear; emergency stop reachable"
            ><input type="checkbox" data-workspace aria-label="Workspace clear; emergency stop reachable" />Workspace
            and Stop clear</label
          >
          <details class="driver-map">
            <summary>Joint map · radians</summary>
            <div data-map></div>
          </details>
        </details>
        <details data-input>
          <summary>Motion input <span data-source-name>Jog</span></summary>
          <div class="driver-row" data-source><button type="button" class="kit-action" data-camera></button></div>
          <div data-jog>
            <div data-joint></div>
            <div data-slider></div>
          </div>
          <p class="driver-note">Local webcam only. Camera images stay on this device.</p>
        </details>
        <div class="driver-leg-row">
          <button type="button" class="kit-action" data-legs></button
          ><span>Driver legs locked · practice keeps full control</span>
        </div>
        <p class="driver-note" data-leg-reason hidden></p>
        <div class="driver-footer">
          <button type="button" class="kit-action driver-deadman" data-deadman aria-pressed="false">
            <span data-deadman-label>Deadman released</span>
          </button>
          <p class="driver-note">Hold here + tap Go live · Shift · gamepad RT</p>
          <div class="driver-actions">
            <button type="button" class="kit-action kit-primary" data-live>Go live</button
            ><button type="button" class="estop" data-stop>Stop</button>
          </div>
        </div>`,
    )
    const get = <T extends HTMLElement = HTMLElement>(name: string) => this.el.querySelector<T>(`[data-${name}]`)!
    get('twin').append(this.figure.el)
    this.panel = panels.add(this.el, {
      id: 'drivers',
      title: 'Simulated drivers',
      purpose: 'Observe a measured twin and test guarded upper-body control',
      icon: 'arm',
      anchor: 'arm',
      state: 'closed',
    })
    // Focus and scroll keep whole confirmation rows above the persistent Stop controls.
    const footer = this.el.querySelector<HTMLElement>('.driver-footer')!
    this.footerSize = new ResizeObserver(() => {
      const height = footer.offsetHeight
      if (!height) return
      const bottom = Math.max(0, parseFloat(getComputedStyle(footer).bottom) || 0)
      this.panel.body.style.scrollPaddingBottom = `${height + bottom + 16}px`
      this.panel.body.style.scrollPaddingTop = '8px'
    })
    this.footerSize.observe(footer)
    const choose = new GlassSelect({
      label: 'Simulated driver',
      value: 'ros',
      items: (['ros', 'g1', 'h1'] as const).map((kind) => ({ value: kind, label: fakeProfile(kind).label })),
      onChange: () => {
        void disconnect()
      },
    })
    get('connection').prepend(choose.button)
    const connect = iconAction(get<HTMLButtonElement>('connect'), 'link', 'Connect simulated driver')
    const disconnectButton = iconAction(get<HTMLButtonElement>('disconnect'), 'close', 'Disconnect driver')
    const cameraButton = iconAction(get<HTMLButtonElement>('camera'), 'camera', 'Open local body camera')
    cameraButton.onclick = camera
    iconAction(get<HTMLButtonElement>('legs'), 'lock', 'Explain driver leg lock').onclick = () => {
      get('leg-reason').hidden = false
      get('leg-reason').textContent = legRefusal(
        this.session.driver?.profile ?? fakeProfile(choose.value as DriverKind),
      )
    }
    const motion = new GlassSelect({
      label: 'Driver motion input',
      value: 'jog',
      items: [
        { value: 'jog', label: 'Jog' },
        { value: 'body', label: 'Local body camera' },
      ],
      onChange: (value) => {
        this.source = value as 'jog' | 'body'
        get('jog').hidden = this.source !== 'jog'
        get('source-name').textContent = this.source === 'jog' ? 'Jog' : 'Local body'
        this.session.target(
          this.source === 'body'
            ? this.body()
            : {
                kind: 'jog',
                token: 'jog',
                positions: { ...this.session.twin },
                at: performance.now(),
                valid: true,
                preset: false,
              },
        )
      },
    })
    get('source').prepend(motion.button)
    const joint = new GlassSelect({ label: 'Joint to jog', items: [], onChange: () => slider() })
    get('joint').append(joint.button)
    const slider = () => {
      const j = this.session.driver?.profile.joints.find((j) => j.id === joint.value)
      if (!j) return
      const control = new DetentSlider({
        label: `Jog ${j.id}`,
        min: j.limits[0],
        max: j.limits[1],
        step: 0.01,
        value: this.session.input.positions[j.id] ?? this.session.twin[j.id],
        format: (value) => `${Math.round((value * 180) / Math.PI)} degrees`,
        onInput: (value) => {
          this.session.target({
            kind: 'jog',
            token: 'jog',
            positions: { ...this.session.input.positions, [j.id]: value },
            at: performance.now(),
            valid: true,
            preset: false,
          })
        },
      })
      get('slider').replaceChildren(control.el)
    }
    const disconnect = async () => {
      this.release('Disconnected')
      await this.session.disconnect()
      this.transport = null
      this.figure.close()
    }
    connect.onclick = async () => {
      if (this.connecting) return
      this.connecting = true
      this.release('New connection')
      const fake = simulatedDriver(choose.value as DriverKind)
      this.transport = fake.transport
      await this.session.connect(fake.driver)
      this.source = 'jog'
      motion.value = 'jog'
      get('jog').hidden = false
      get('source-name').textContent = 'Jog'
      get<HTMLInputElement>('mapping').checked = get<HTMLInputElement>('workspace').checked = false
      joint.setItems(upperJoints(fake.driver.profile).map((j) => ({ value: j.id, label: j.id.replaceAll('.', ' ') })))
      joint.value = 'left.arm.elbow'
      slider()
      const table = document.createElement('table')
      setMarkup(
        table,
        html`<thead>
            <tr>
              <th>Joint</th>
              <th>Wire / index</th>
              <th>Limits</th>
            </tr>
          </thead>
          <tbody>
            ${fake.driver.profile.joints.map(
              (j) =>
                html`<tr>
                  <td>${j.id}</td>
                  <td>${j.wire} / ${j.index}</td>
                  <td>${j.limits.map((n) => n.toFixed(2)).join(' … ')}</td>
                </tr>`,
            )}
          </tbody>`,
      )
      get('map').replaceChildren(table)
      get<HTMLDetailsElement>('checklist').open = true
      this.connecting = false
      render()
    }
    disconnectButton.onclick = () => {
      void disconnect()
    }
    for (const id of ['mapping', 'workspace'] as const)
      get<HTMLInputElement>(id).onchange = () => {
        this.session.confirmations[id] = get<HTMLInputElement>(id).checked
        if (this.session.active && !this.session.confirmations[id])
          void this.session.stop('Checklist confirmation removed')
        render()
      }
    get<HTMLButtonElement>('live').onclick = () => this.session.goLive()
    get<HTMLButtonElement>('stop').onclick = () => {
      void this.session.stop('Stop')
    }
    const deadman = get<HTMLButtonElement>('deadman')
    deadman.onpointerdown = (event) => {
      if (event.button !== 0 || !this.hold(`pointer:${event.pointerId}`)) return
      event.preventDefault()
      deadman.setPointerCapture(event.pointerId)
    }
    const pointerRelease = (event: PointerEvent) => {
      if (this.inputOwner === `pointer:${event.pointerId}`) this.release('Deadman released')
    }
    deadman.onpointerup = deadman.onpointercancel = deadman.onlostpointercapture = pointerRelease
    deadman.oncontextmenu = (event) => event.preventDefault()
    addEventListener('keydown', (event) => {
      if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !event.repeat && this.panel.visible)
        this.hold(event.code)
      // Space is reserved for the sim's Stop, including when this button has focus.
    })
    addEventListener('keyup', (event) => {
      if (this.inputOwner === event.code) this.release('Deadman released')
    })
    addEventListener('blur', () => this.release('Page lost focus'))
    addEventListener('pagehide', () => {
      this.release('Page released')
      void disconnect()
      clearInterval(this.timer)
    })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.release('Page hidden')
    })
    addEventListener('obpal:panels', () => {
      if (!this.panel.visible) this.release('Driver panel closed')
    })
    let lastState = '',
      lastReason = ''
    const render = () => {
      const live = this.session,
        connected = !!live.driver && live.state !== 'connecting'
      this.el.dataset.state = live.state
      get<HTMLInputElement>('mapping').checked = live.confirmations.mapping
      get<HTMLInputElement>('workspace').checked = live.confirmations.workspace
      if (lastState !== live.state) {
        get('state').textContent = {
          disconnected: 'Disconnected',
          connecting: 'Connecting',
          observe: 'Observe only',
          arming: 'Arming',
          live: 'Live simulation',
          stopped: 'Stopped',
          fault: 'Held · fault',
        }[live.state]
        const waiting = live.state === 'connecting' || live.state === 'arming'
        get('state').classList.toggle('dot-wait-label', waiting)
        dotLoading(get('state').parentElement!, waiting, live.state === 'arming' ? 'Waiting for guardian acknowledgement' : 'Connecting to driver')
        lastState = live.state
      }
      if (lastReason !== live.reason) {
        get('reason').textContent = live.reason
        lastReason = live.reason
      }
      connect.disabled = this.connecting || live.state === 'connecting' || !!live.driver
      disconnectButton.disabled = !live.driver || this.connecting
      choose.button.disabled = this.connecting || !!live.driver
      deadman.disabled = !connected
      deadman.dataset.held = String(live.held)
      deadman.setAttribute('aria-pressed', String(live.held))
      const label = live.held ? 'DEADMAN HELD' : 'Deadman released'
      if (get('deadman-label').textContent !== label) get('deadman-label').textContent = label
      get<HTMLButtonElement>('stop').disabled = !live.driver
      get<HTMLButtonElement>('live').disabled = !connected || live.active || !live.checks.every((check) => check.ok)
      const checks = live.checks,
        list = get('checks')
      for (const check of checks) {
        let item = list.querySelector<HTMLElement>(`[data-check="${check.id}"]`)
        if (!item) {
          item = document.createElement('li')
          item.dataset.check = check.id
          list.append(item)
        }
        item.dataset.ok = String(check.ok)
        const label = `${check.ok ? '✓' : '○'} ${check.label}`
        if (item.textContent !== label) item.textContent = label
        item.title = check.ok ? check.label : check.reason
      }
      get('check-count').textContent = connected ? `${checks.filter((c) => c.ok).length} / ${checks.length}` : ''
      if (!live.driver) list.replaceChildren()
    }
    this.session.onChange = render
    this.timer = setInterval(() => {
      const visible = this.panel.visible && !document.hidden
      if (this.wasVisible && !visible) this.release('Driver panel closed')
      this.wasVisible = visible
      const pads = navigator.getGamepads?.() ?? []
      const pressed = Array.from(pads).find((p) => p?.connected && p.buttons[7]?.pressed)
      if (!pressed) {
        this.padReleased = true
        if (this.inputOwner.startsWith('pad:')) this.release('Gamepad deadman released')
      } else if (this.padReleased && visible) {
        this.padReleased = false
        this.hold(`pad:${pressed.index}`)
      } else if (this.inputOwner.startsWith('pad:') && this.inputOwner !== `pad:${pressed.index}`)
        this.release('Gamepad changed')
      if (this.source === 'body') this.session.target(this.body())
      this.session.tick()
      const now = performance.now()
      if (visible && this.session.driver && !this.connecting && now - this.lastDraw >= 1000 / 30) {
        this.figure.draw(this.session.twin)
        this.lastDraw = now
      }
    }, TIMING.renewal)
    fitControlInk(this.el)
    render()
  }
  private hold(owner: string) {
    if (this.inputOwner || !this.panel.visible || document.hidden || !this.session.driver) return false
    this.inputOwner = owner
    this.session.deadman(true)
    return true
  }
  release(reason: string) {
    this.inputOwner = ''
    this.session.deadman(false)
    if (this.session.active) void this.session.stop(reason)
  }
}
