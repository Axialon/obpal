const spec = JSON.parse(decodeURIComponent(location.hash.slice(1)))
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
document.body.className = spec.scene
document.body.innerHTML = `<div class="light"></div><img class="brand" src="/public/brand/obpal-link-lockup.svg" alt="ob.Pal Link"><h1>${esc(spec.title).replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>')}</h1><p class="subtitle">${esc(spec.sub)}</p>`
if (spec.scene === 'keys') document.body.insertAdjacentHTML('beforeend', '<p class="key-map">Left stick → WASD <span>D-pad → arrows</span> A → Space</p>')
if (spec.scene === 'pairing') document.body.insertAdjacentHTML('beforeend', '<p class="seal-note">The seal is a comparison aid, not certification.</p>')
if (spec.scene === 'trust') {
  const icons = [
    ['<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', 'End to end'],
    ['<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0M3 3l18 18"/>', 'No accounts'],
    ['<circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/>', 'Compare the seal'],
  ]
  document.body.insertAdjacentHTML('beforeend', `<div class="facts">${icons.map(([path, label]) => `<div class="fact"><svg viewBox="0 0 24 24">${path}</svg><span>${label}</span></div>`).join('')}</div>`)
}
for (const it of spec.items) {
  const [cx, cy, cw, ch] = it.crop ?? [0, 0, it.w, it.h]
  const scale = it.width / cw
  const frame = document.createElement('div')
  frame.className = `item ${it.kind}`
  Object.assign(frame.style, { left: `${it.x}px`, top: `${it.y}px`, width: `${it.width}px`, height: `${it.height ?? ch * scale}px`, zIndex: it.z ?? 1 })
  const img = document.createElement('img')
  img.src = it.src
  img.alt = ''
  Object.assign(img.style, { left: `${-cx * scale}px`, top: `${-cy * scale}px`, width: `${it.w * scale}px`, height: `${it.h * scale}px` })
  frame.appendChild(img)
  document.body.appendChild(frame)
  if (it.label) document.body.insertAdjacentHTML('beforeend', `<span class="panel-label" style="left:${it.x}px;top:${it.y - 34}px">${esc(it.label)}</span>`)
}

document.body.dataset.renderReady = 'true'
