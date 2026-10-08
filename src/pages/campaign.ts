/** Local review pages: native appearance, decorative dots, and a page-only enquiry preview. */
import './campaign.css'
import { applyTheme, themeById, THEMES } from '../ui/themes'
import { mountMarks } from '../ui/icons'
import { DotField } from '../ui/kit/dot-field'
import { glyphDots } from '@obpal/core'

applyTheme(themeById(undefined))
mountMarks()

const surface = document.querySelector<HTMLSelectElement>('#campaign-surface')
surface?.addEventListener('change', () => applyTheme(themeById(surface.value)))
if (surface) surface.value = document.documentElement.dataset.bbTheme ?? THEMES[0].id

const fields = [...document.querySelectorAll<HTMLCanvasElement>('[data-campaign-glyph]')].map(canvas =>
  new DotField(canvas, { points: glyphDots(Number(canvas.dataset.campaignGlyph)), preservePoints: true, maxDots: 80 }))
const refresh = () => {
  if (surface) surface.value = document.documentElement.dataset.bbTheme ?? THEMES[0].id
  fields.forEach(field => field.refresh())
}
const restore = (event: PageTransitionEvent) => { if (event.persisted) refresh() }
const leave = (event: PageTransitionEvent) => {
  if (event.persisted) return
  window.removeEventListener('bb-theme', refresh)
  window.removeEventListener('pageshow', restore)
  window.removeEventListener('pagehide', leave)
  fields.forEach(field => field.destroy())
}
window.addEventListener('bb-theme', refresh)
window.addEventListener('pageshow', restore)
window.addEventListener('pagehide', leave)

const button = document.querySelector<HTMLButtonElement>('#enquiry-preview-button')
const output = document.querySelector<HTMLElement>('#enquiry-summary')
const preview = document.querySelector<HTMLElement>('#enquiry-preview')
const status = document.querySelector<HTMLElement>('#enquiry-status')
const inputs = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-enquiry-field]')]
// A reload starts a new, empty draft, including browsers that restore control values.
inputs.forEach(input => { input.value = '' })
if (button && output && preview && status) {
  button.addEventListener('click', () => {
    output.textContent = inputs.map(input => `${input.dataset.enquiryField}:\n${input.value.trim() || 'Not specified'}`).join('\n\n')
    preview.hidden = false
    status.textContent = 'Preview ready on this page only. Nothing was sent.'
    preview.focus()
  })
  button.disabled = false
}
