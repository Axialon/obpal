import { sheetExits } from '../controller/sheet'

const SHARES = [
  ['While connected', 'Motion, touch, buttons and typing go to the screen when you use those controls.'],
  ['Camera, when you tap it', 'Camera frames stay on this phone. Hand and body controls send landmarks to the screen.'],
  ['Storage', 'ob.Pal does not store your control input. Pairings and preferences are saved on your phone. A connected website can handle input under its own policy.'],
  ['Your choice', 'Disconnect any time. Feedback is voluntary, through the contact on the privacy page.'],
] as const

/** The same plain account of sharing, one tap from the phone's first frame or connection details. */
export function showShares(disconnect: () => void): () => void {
  const previous = document.activeElement as HTMLElement | null
  const wrap = document.createElement('div')
  wrap.className = 'sheet-wrap'
  const card = document.createElement('div')
  card.className = 'sheet shares-sheet glass'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', 'What this shares')
  const heading = document.createElement('h2')
  heading.textContent = 'What this shares'
  const closeButton = document.createElement('button')
  closeButton.className = 'btn shares-close'
  closeButton.textContent = 'Close'
  closeButton.type = 'button'
  card.append(heading)
  for (const [title, detail] of SHARES) {
    const row = document.createElement('p')
    const name = document.createElement('b')
    const text = document.createElement('span')
    name.textContent = title
    text.textContent = detail
    row.append(name, text)
    card.append(row)
  }
  const trust = document.createElement('a')
  trust.href = '/trust/'
  trust.textContent = 'How to check ob.Pal'
  const leave = document.createElement('button')
  leave.type = 'button'
  leave.className = 'btn'
  leave.textContent = 'Disconnect'
  card.append(trust, leave, closeButton)
  wrap.append(card)
  let exits = () => {}
  let dead = false
  const close = () => { if (dead) return; dead = true; exits(); wrap.remove(); previous?.focus() }
  closeButton.addEventListener('click', close)
  leave.addEventListener('click', () => { close(); disconnect() })
  // Keep keyboard navigation within the modal; the sheet already handles Back, Escape and the backdrop.
  wrap.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const stops = [trust, leave, closeButton]
    const at = stops.indexOf(document.activeElement as HTMLAnchorElement | HTMLButtonElement)
    event.preventDefault()
    stops[(at + (event.shiftKey ? stops.length - 1 : 1)) % stops.length].focus()
  })
  document.body.append(wrap)
  exits = sheetExits(wrap, close)
  closeButton.focus()
  return close
}
