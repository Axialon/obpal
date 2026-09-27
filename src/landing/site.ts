// The site's plain pages (the sims hub, Link, privacy): the palette, the logo, and the top bar with the family's switcher.
import { applyTheme, initialTheme } from '../ui/themes'
import { mountMarks } from '../ui/icons'
import { mountTopBar } from './topbar'

applyTheme(initialTheme())
mountMarks()
mountTopBar()
