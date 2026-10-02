import './journey.css'
import { mountConstellation } from './constellation'

const illustration = mountConstellation()
let step: 'pair' | 'enable' | 'try' | null = null, pc = false
const previewNote = document.querySelector<HTMLElement>('#hero-preview-note')!
const previewSteps = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-link-step]'))
function preview(replay = true) {
  illustration.setState(step === 'pair' ? 'pairing' : step ? 'connected' : 'idle', pc, replay)
  previewSteps.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.linkStep === step)))
  previewNote.textContent = step === 'pair' ? 'Pair preview. A paired phone still has input off.'
    : step === 'enable' ? 'Enable preview. This tab is a choice; PC permission is separate.'
    : step === 'try' ? 'Try preview. Use the dot demo after enabling This tab in Link.'
    : 'Journey preview. A connection is the start. You choose what it controls.'
}
previewSteps.forEach(button => button.addEventListener('click', () => { step = button.dataset.linkStep as typeof step; preview() }))
document.querySelectorAll('.journey-flow article').forEach((article, index) => {
  article.addEventListener('pointerenter', () => { step = (['pair', 'enable', 'try'] as const)[index]; preview() })
  article.addEventListener('focusin', () => { step = (['pair', 'enable', 'try'] as const)[index]; preview() })
})
document.querySelector('#hero-pc')!.addEventListener('click', event => {
  pc = !pc
  const button = event.currentTarget as HTMLButtonElement
  button.setAttribute('aria-pressed', String(pc))
  preview(); previewNote.textContent += pc ? ' PC route preview only; nothing is allowed by this page.' : ' PC route is inactive.'
})
document.querySelector('#hero-reset')!.addEventListener('click', () => {
  step = null; pc = false; preview()
  document.querySelector('#hero-pc')!.setAttribute('aria-pressed', 'false')
  illustration.setState('dropped', false)
  previewNote.textContent = 'Reset preview. The connection rests; PC access remains a separate choice.'
})
window.addEventListener('pageshow', event => { if (event.persisted) preview(false) })
const returnNote = document.querySelector<HTMLElement>('#store-return')!
const store = document.querySelector<HTMLAnchorElement>('#store-route')!
store.addEventListener('click', () => { returnNote.hidden = false })
window.addEventListener('focus', () => { if (!returnNote.hidden) returnNote.scrollIntoView({ block: 'nearest' }) })

document.querySelector('#share-link')!.addEventListener('click', async () => {
  const note = document.querySelector<HTMLElement>('#share-note')!
  try { await navigator.clipboard.writeText(location.origin + '/link/'); note.textContent = 'Page link copied.' }
  catch { note.textContent = location.origin + '/link/' }
})
