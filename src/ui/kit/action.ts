/** A familiar action, with its spoken name and the family's glass tooltip kept together. */
import { ICONS } from '../icons'
import { setMarkup } from '../markup'
import { initTips } from '../tips'

let tipsReady = false

export function iconAction(button: HTMLButtonElement, glyph: string, label: string) {
  if (!tipsReady) { if (!document.querySelector('.tip[role="tooltip"]')) initTips(); tipsReady = true }
  button.classList.add('kit-icon-action')
  button.setAttribute('aria-label', label)
  button.dataset.tip = button.title || label
  button.removeAttribute('title')
  delete button.dataset.icon
  setMarkup(button, ICONS[glyph])
  return button
}

/** Only familiar sim actions lose their words; device-specific actions keep them. */
export const SIM_ACTION_ICONS: Readonly<Record<string, string>> = {
  Home: 'reset', Reset: 'reset', Grip: 'grip', 'Open grip': 'grip-open', 'Close grip': 'grip-close',
  'Home all': 'reset', 'Reset scores': 'reset', 'Reset view': 'center', 'Recentre view': 'center', Close: 'close',
  Play: 'play', Pause: 'pause', 'Play / stop': 'play', Record: 'record', 'Record / stop': 'record',
  Camera: 'camera', 'Zoom in': 'zoom-in', 'Zoom out': 'zoom-out', Help: 'help', Speed: 'speed',
}
