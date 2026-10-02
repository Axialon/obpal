import { deviceMotif } from './motif.mjs'
import { POSTERS } from './scenes.mjs'
const type = document.body.dataset.poster
const spec = POSTERS[type]
const brand = '<img class="brand" src="/public/brand/obpal-link-lockup.svg" alt="ob.Pal Link">'
document.body.innerHTML = `<div class="light"></div>${brand}<h1>${spec.title.replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>')}</h1><div class="motif">${deviceMotif(`/captures/${spec.phone}.png`)}</div>${spec.sub ? `<p class="journey">${spec.sub}</p>` : ''}`
document.body.dataset.renderReady = 'true'
