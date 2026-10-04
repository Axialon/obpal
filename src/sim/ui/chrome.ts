/**
 * The sims' chrome as policy, apart from the page: how long a new phone's seal shows, and which quick actions the tray
 * shows on a sim. Every feature has one home on a sim's screen; the tray keeps the system actions and the camera's
 * views, and the rest live where they belong (pairing on the chip; sound, reset, stop and the body camera in the sim's
 * own windows). Their keys stay.
 */
import type { QuickId } from '../../ui/quick-actions'

/** How long a new phone's seal shows in the pairing card before the card folds and leaves it on the chip. */
export const SEAL_SHOWN_MS = 4000

/**
 * What a sim's tray shows: switching the lead phone's controller, the camera's views (their home until the view dial
 * lands; on a phone, first person stays two taps away), full screen, minimising the chrome and the theme.
 */
export const SIM_TRAY: readonly QuickId[] = ['switch', 'camera', 'fullscreen', 'minimise', 'theme']

/**
 * Whether the tray shows an action on this page: on a sim, only its system actions (and, on a phone, whose pill scans
 * other screens, the way to show this screen's own code); elsewhere, everything offered.
 */
export function trayShows(id: QuickId, sim: boolean, phone = false): boolean {
  return !sim || SIM_TRAY.includes(id) || (phone && id === 'pair')
}
