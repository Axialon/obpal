/**
 * The Controls window's sections fold (progressive disclosure): each section's head carries a chevron, and a folded
 * section keeps only its head (its number, title and any action in its aside, such as Sound's mute or Units' Home all).
 * What a person folds is remembered per sim and screen class; the first time, the rarely used ones start folded: the
 * controllers' how-to (the phone has its own), the sound level (its mute stays on the head), and a sim's units when it
 * has just one. The sim's identity keeps its name; its description is an ⓘ away.
 */
import '../../styles/sections.css'

export interface FoldStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** A section's key in the remembered state: its title's id, else its title's words. */
export function sectionKey(section: Element): string {
  const title = section.querySelector('.kit-card-head .kit-card-title')
  return title?.id || title?.textContent?.trim().toLowerCase().replace(/\s+/g, '-') || ''
}

/** Read the folds remembered for one sim on one screen class; storage may be missing or blocked. */
export function readFolds(store: FoldStore | null, key: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(key) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'))
  } catch { return {} }
}
export function writeFolds(store: FoldStore | null, key: string, folds: Record<string, boolean>) {
  try { store?.setItem(key, JSON.stringify(folds)) } catch { /* storage blocked or full: folds last this visit */ }
}

/**
 * Whether a section starts folded before anyone chose: the how-to of the controllers (Controllers), the sound level
 * (Sound), the humanoids' scoring options (Practice: its score is on the HUD), and the units of a sim with a single unit.
 * Everything else, including whatever drives the sim, starts open.
 */
export function foldsByDefault(key: string, units: number): boolean {
  if (key === 'dev-faces-h' || key === 'sim-sound-h' || key === 'practice') return true
  if (key === 'dev-units-h') return units <= 1
  return false
}

const CHEVRON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
const INFO = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2M12 7.7v.1"/></svg>'

/** Fold the window's sections, now and as they arrive (the sound card comes later), remembering each choice. */
export function foldSections(panel: HTMLElement, key: string, store: FoldStore | null = safeStorage()) {
  const folds = readFolds(store, key)
  const units = () => document.querySelectorAll('#dev-units > li').length
  const setFolded = (section: HTMLElement, button: HTMLButtonElement, folded: boolean) => {
    section.toggleAttribute('data-folded', folded)
    button.setAttribute('aria-expanded', String(!folded))
    const title = section.querySelector('.kit-card-title')?.textContent?.trim() ?? 'section'
    button.setAttribute('aria-label', `${folded ? 'Show' : 'Hide'} ${title}`)
  }
  const enhance = (section: HTMLElement) => {
    const head = section.querySelector<HTMLElement>(':scope > .kit-card-head')
    const id = sectionKey(section)
    if (!head || !id || head.querySelector('.kit-card-fold')) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'kit-card-fold'
    button.innerHTML = CHEVRON
    head.append(button)
    const choose = () => { const folded = !section.hasAttribute('data-folded'); setFolded(section, button, folded); folds[id] = folded; writeFolds(store, key, folds) }
    button.onclick = choose
    // The title is part of the target too (a bigger one); the aside's own buttons keep their clicks.
    head.querySelector('.kit-card-title')?.addEventListener('click', choose)
    // Units are counted once the sim has drawn them.
    requestAnimationFrame(() => setFolded(section, button, folds[id] ?? foldsByDefault(id, units())))
    setFolded(section, button, folds[id] ?? foldsByDefault(id, units()))
  }
  const scan = () => panel.querySelectorAll<HTMLElement>(':is(.sim-sec, .sim-sound)').forEach(enhance)
  scan()
  new MutationObserver(scan).observe(panel, { childList: true, subtree: true })
  aboutToggle(panel)
}

/** The sim's description behind an ⓘ beside its name, open on a press, folded again on another. */
function aboutToggle(panel: HTMLElement) {
  const id = panel.querySelector<HTMLElement>('.sim-id')
  const lede = id?.querySelector<HTMLElement>(':scope > .sim-lede')
  const name = id?.querySelector('h1')
  if (!id || !lede || !name || id.querySelector('.sim-about')) return
  lede.id ||= 'sim-about-text'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'sim-about'
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-controls', lede.id)
  button.setAttribute('aria-label', 'About this sim')
  button.innerHTML = INFO
  button.onclick = () => { const open = !id.hasAttribute('data-about'); id.toggleAttribute('data-about', open); button.setAttribute('aria-expanded', String(open)) }
  name.after(button)
}

function safeStorage(): FoldStore | null {
  try { return localStorage } catch { return null }
}
