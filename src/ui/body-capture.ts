/** Opt-in webcam input. It has no transport, recording, preference or automatic restart. */
import { BodyInput } from '@obpal/host'
import { BodyTracker } from '../controller/body-tracker'
import { CameraView } from './camera'
import { mountQuick, quickAction, quickChanged } from './quick'
import { ICONS } from './icons'
import { setMarkup } from './markup'

let mounted: BodyInput | null = null
let toggle: (() => void) | null = null
/** Another explicit camera button may share the same capture lifetime as the shortcut. */
export function toggleBodyCapture() { toggle?.() }

export function mountBodyCapture(options: { beforeOpen?: () => boolean; closed?: () => void } = {}): BodyInput {
  if (mounted) return mounted
  const input = new BodyInput()
  mounted = input
  let camera: CameraView | null = null, tracker: BodyTracker | null = null
  let seq = 0, gen = 0
  let button: HTMLButtonElement | null = null
  function changed() { quickChanged(); button?.setAttribute('aria-pressed', String(camera?.capturing ?? false)) }
  const timeOrigin = performance.now()
  const test = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && new URLSearchParams(location.search).get('test') === 'camera'
  function stop() { camera?.close() }
  function open() {
    if (camera) { stop(); return }
    if (options.beforeOpen && !options.beforeOpen()) return
    const view = new CameraView({ mode: 'body', local: true, measurements: test, changed,
      typed: stop,
      reset: () => { tracker?.stop(); tracker = null; input.reset() },
      close: () => { tracker?.stop(); tracker = null; input.reset(); camera = null; changed(); options.closed?.() },
      ready: (video, overlay) => {
        if (camera !== view) return
        tracker?.stop(); input.reset()
        const next = new BodyTracker(video, overlay, {
          // This sink is deliberately local and cannot call Remote.send or create a network connection.
          send: packet => input.receive(packet), timeOrigin,
          sequence: () => (seq = (seq + 1) & 65535), generation: () => (gen = (gen + 1) & 255),
          say: text => view.say(text), loading: p => view.loading(p), error: text => { input.reset(); view.unavailable(text) },
          metrics: m => { if (test) view.setMetrics(`${m.trackingFps.toFixed(0)} fps · ${m.latencyP95Ms.toFixed(0)} ms`) },
        })
        tracker = next
        void view.prepareBody(() => { if (tracker === next && camera === view) next.start() })
      },
    })
    camera = view
    view.open()
    changed()
  }
  toggle = open
  quickAction({ id: 'body', group: 'page', label: 'Body camera', hint: 'Camera frames stay on this device', icon: 'camera', pressed: () => camera?.capturing ?? false, run: open })
  // Arms already use all four page shortcuts, including Stop. Keep capture available in their camera panel too.
  const glow = document.querySelector('#glow-cam')
  if (glow) {
    button = document.createElement('button'); button.type = 'button'; button.className = 'kit-action'
    setMarkup(button, ICONS.camera); button.append(document.createTextNode('Body camera'))
    button.dataset.bodyCapture = ''; button.setAttribute('aria-pressed', 'false'); button.onclick = open
    glow.after(button)
  }
  mountQuick()
  if (test) Object.assign(window, { __cameraBody: {
    read: () => input.read(), stats: () => tracker?.stats ?? null,
    inject: (result: Parameters<BodyTracker['injectForTest']>[0]) => tracker?.injectForTest(result),
  } })
  return input
}
