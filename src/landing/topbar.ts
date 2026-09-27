/**
 * The site's top bar (home, catalogue): the family's app switcher by the logo, and on a narrow screen a menu for the
 * links that don't fit. Both are the family's glass popovers.
 */
import { family } from '../family'

export function mountTopBar() {
  const sw = document.getElementById('t-switch')
  const menu = document.getElementById('switcher')
  if (sw && menu) {
    if (!sw.innerHTML.trim()) sw.innerHTML = family.icons.chevron
    family.mountSwitcher(sw, menu, 'obpal')
  }
  const more = document.getElementById('t-menu')
  const links = document.getElementById('site-menu')
  if (more && links) {
    const pop = family.popover(more, links)
    // A link to a section of this page closes the menu on the way.
    links.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) pop.close() })
  }
}
