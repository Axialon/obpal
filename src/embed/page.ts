/**
 * The site around the embed demo (/embed/): theme, logo and top bar, the snippet's copy button, and the chip moved out
 * of the panel's way on a narrow screen. The demo itself is ./demo.ts.
 */
import '../styles/base.css'
import '../styles/sim.css'
import '../styles/embed.css'
import { applyTheme, initialTheme } from '../ui/themes'
import { mountMarks } from '../ui/icons'
import { mountTopBar } from '../landing/topbar'

applyTheme(initialTheme())
mountMarks()
mountTopBar()

const copy = document.getElementById('copy')!
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById('snippet')!.textContent ?? '')
    copy.textContent = 'Copied'
  } catch {
    copy.textContent = 'Select and copy'
  }
  setTimeout(() => { copy.textContent = 'Copy' }, 1600)
})

// On a wide screen the code shows at once (the chip opens, and that starts the remote). On a narrow one the panel is a
// sheet along the bottom, so the chip goes to the top corner and starts closed: that screen is most likely the phone
// itself, and the code would cover the shapes. This runs before or after /embed.js defines the element; either works.
const narrow = matchMedia('(max-width: 860px)')
const chip = document.querySelector('obpal-remote')
const place = () => chip?.setAttribute('corner', narrow.matches ? 'top-right' : 'bottom-right')
narrow.addEventListener('change', place)
place()
if (!narrow.matches) chip?.setAttribute('open', '')
