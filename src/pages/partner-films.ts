/** Complete films remain usable without this optional appearance and sharing layer. */
import './partner-films.css'
import { applyTheme, themeById } from '../ui/themes'
import { mountMarks } from '../ui/icons'
import { DotField } from '../ui/kit/dot-field'
import { glyphDots } from '@obpal/core'

applyTheme(themeById(undefined))
mountMarks()
const surface = document.querySelector<HTMLSelectElement>('#film-surface')!
const dots = new DotField(document.querySelector<HTMLCanvasElement>('#film-dots')!, { points: glyphDots(0), preservePoints: true, maxDots: 80 })
const refresh = () => {
  surface.value = document.documentElement.dataset.bbTheme ?? 'carbon'
  dots.refresh()
}
surface.hidden = false
surface.previousElementSibling?.removeAttribute('hidden')
surface.addEventListener('change', () => applyTheme(themeById(surface.value)))
window.addEventListener('bb-theme', refresh)
window.addEventListener('pageshow', refresh)
window.addEventListener('pagehide', (event: PageTransitionEvent) => {
  if (event.persisted) return
  window.removeEventListener('bb-theme', refresh)
  window.removeEventListener('pageshow', refresh)
  dots.destroy()
})
refresh()

for (const group of document.querySelectorAll<HTMLElement>('[data-film-share]')) {
  const link = group.querySelector<HTMLAnchorElement>('[data-permalink]')!
  const manual = group.querySelector<HTMLInputElement>('input')!
  const status = group.querySelector<HTMLElement>('[role="status"]')!
  const url = new URL(link.getAttribute('href')!, location.origin).href
  manual.value = url
  manual.parentElement!.hidden = false
  for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
    button.hidden = false
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        if (button.dataset.action === 'share' && typeof navigator.share === 'function') {
          await navigator.share({ title: group.dataset.filmShare, url })
          status.textContent = "Link handed to your device's sharing feature."
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url)
          status.textContent = 'Link copied.'
        } else {
          status.textContent = 'Select and copy the link below.'
          manual.focus()
          manual.select()
        }
      } catch (error) {
        status.textContent = error instanceof DOMException && error.name === 'AbortError'
          ? 'Sharing cancelled or unavailable. Select and copy the link below if you want to share it.'
          : 'Sharing or copying was unavailable. Select and copy the link below.'
        manual.focus()
        manual.select()
      } finally { button.disabled = false }
    })
  }
}
