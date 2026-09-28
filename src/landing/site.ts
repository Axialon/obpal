// The site's plain pages (the sims hub, Link, privacy): the palette, the logo, the top bar with the family's switcher,
// and the quick-actions tray (pairing, by way of the viewer, and fullscreen).
import { applyTheme, initialTheme } from '../ui/themes'
import { mountMarks } from '../ui/icons'
import { mountTopBar } from './topbar'
import { mountQuick } from '../ui/quick'

applyTheme(initialTheme())
mountMarks()
mountTopBar()
mountQuick()
