import './journey.css'
import { mountConstellation } from './constellation'

mountConstellation()
const returnNote = document.querySelector<HTMLElement>('#store-return')!
const store = document.querySelector<HTMLAnchorElement>('#store-route')!
store.addEventListener('click', () => { returnNote.hidden = false })
window.addEventListener('focus', () => { if (!returnNote.hidden) returnNote.scrollIntoView({ block: 'nearest' }) })

document.querySelector('#share-link')!.addEventListener('click', async () => {
  const note = document.querySelector<HTMLElement>('#share-note')!
  try { await navigator.clipboard.writeText(location.origin + '/link/'); note.textContent = 'Page link copied.' }
  catch { note.textContent = location.origin + '/link/' }
})
