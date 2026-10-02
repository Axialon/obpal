/**
 * The question Link's pages put to the person at the PC when a phone wants PC control (spec/SECURITY.md §8, L1):
 * "<phone> wants to control this PC", with Allow and Deny. One prompt, answered once per phone: the service worker
 * keeps the answer (shared/access.ts). As it appears it takes the keyboard's focus itself, not a button's, so a screen
 * reader reads the question and a stray Enter answers nothing; Tab goes on to Allow, then Deny.
 */
import { dotLoading } from '../../../src/ui/kit/loading'
import { ICONS } from '../../../src/ui/icons'
import type { Phone } from '../shared/access'

/** The prompt's card, hidden until there's a question. `answer` is called with the phone's key and the answer. */
export function askCard(answer: (key: string, allow: boolean) => void): HTMLElement {
  const el = document.createElement('section')
  el.className = 'card ask'
  el.id = 'ask'
  el.tabIndex = -1
  el.hidden = true
  el.setAttribute('aria-labelledby', 'ask-t')
  el.setAttribute('aria-describedby', 'ask-d')
  el.innerHTML = `
    <span class="ask-ic" aria-hidden="true">${ICONS.phone}</span>
    <div class="ask-text">
      <h2 id="ask-t">Allow this phone? <b></b></h2>
      <p id="ask-d">PC mouse, keyboard and typing. Program scope is a separate choice.</p>
    </div>
    <div class="ask-actions">
      <button class="btn primary" type="button" data-allow="true">Allow</button>
      <button class="btn" type="button" data-allow="false">Deny</button>
    </div>`
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-allow]')
    const key = el.dataset.key
    if (!b || !key || el.getAttribute('aria-busy') === 'true') return
    // Answered: nothing more from these buttons until the next question.
    el.setAttribute('aria-busy', 'true')
    el.querySelector('.ask-ic')!.removeAttribute('aria-hidden')
    dotLoading(el.querySelector<HTMLElement>('.ask-ic')!, true, 'Saving your answer')
    answer(key, b.dataset.allow === 'true')
  })
  return el
}

/**
 * Show the question about `ask`, or none. A new question takes the focus (the popup opened for it, or it came while
 * the page was open); the page hands the focus on (`away`) once the question is gone, if the prompt still had it.
 */
export function showAsk(el: HTMLElement, ask: Phone | null, away?: () => void) {
  const was = el.dataset.key ?? ''
  const had = el.contains(document.activeElement)
  el.dataset.key = ask?.key ?? ''
  el.hidden = !ask
  if (!ask) {
    el.removeAttribute('aria-busy')
    el.querySelector('.ask-ic')!.setAttribute('aria-hidden', 'true')
    dotLoading(el.querySelector<HTMLElement>('.ask-ic')!, false)
    if (was && had) away?.()
    return
  }
  el.querySelector('#ask-t b')!.textContent = ask.name
  if (ask.key === was) return
  el.removeAttribute('aria-busy')
  el.querySelector('.ask-ic')!.setAttribute('aria-hidden', 'true')
  dotLoading(el.querySelector<HTMLElement>('.ask-ic')!, false)
  requestAnimationFrame(() => { if (!el.hidden) el.focus() })
}
