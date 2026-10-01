import { DotField } from '../ui/kit/dot-field'
import { constellationPoints } from './constellation-points'
import './journey.css'
import { parseGuideStatus } from '../../extension/src/shared/desktop-guide'

const status = document.querySelector<HTMLElement>('#guide-status')!
const detail = document.querySelector<HTMLElement>('#guide-detail')!
const check = document.querySelector<HTMLButtonElement>('#desktop-check')!
let expiry = 0
const expired = () => {
  status.textContent = 'Link has not reported recently. Reopen Link to check Desktop.'
  delete status.dataset.helper
  check.hidden = true
}
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return
  const value = parseGuideStatus(event.data)
  if (!value) return
  clearTimeout(expiry)
  expiry = window.setTimeout(expired, 6000)
  check.hidden = false
  const descriptions = {
    off: 'Link is present. Desktop has not been checked.',
    permission: 'Link is present. Native-messaging permission is needed to check Desktop.',
    connecting: 'Link is checking Desktop.',
    missing: 'Link could not find Desktop. Check install.cmd’s output, then retry in Link.',
    error: 'Link could not connect to Desktop. Open Link’s PC settings for the explanation.',
    ready: `Desktop is connected${value.version ? ` · ${value.version}` : ''}. Phone and program permission are still separate.`,
  }
  status.textContent = descriptions[value.status]
  status.dataset.helper = value.status
  detail.textContent = 'Check in Link opens its PC settings. Pairing, Allow/Deny and program scope stay there.'
})
document.addEventListener('visibilitychange', () => {
  clearTimeout(expiry)
  if (!document.hidden) expiry = window.setTimeout(expired, 6000)
})

let diagram: DotField
const theme = new MutationObserver(() => diagram.refresh())
const canvas = document.querySelector<HTMLCanvasElement>('#install-dots')!
const points = () => { const rect = canvas.getBoundingClientRect(); return constellationPoints(rect.width, rect.height) }
const resize = new ResizeObserver(() => diagram.setPoints(points()))
const mountDiagram = () => {
  diagram = new DotField(canvas, { points: points(), scale: 'base', role: 'ink', surface: 'transparent', idle: false })
  resize.observe(canvas)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bb-theme', 'data-bb-accent'] })
}
mountDiagram()
window.addEventListener('pagehide', () => { clearTimeout(expiry); theme.disconnect(); resize.disconnect(); diagram.destroy() })
window.addEventListener('pageshow', event => { if (event.persisted) mountDiagram() })
