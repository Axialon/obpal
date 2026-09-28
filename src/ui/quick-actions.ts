/**
 * The quick-actions tray's registry (the tray itself is ./quick.ts): what a page offers in it. A page, or a part of one
 * (the sims' sound card, the studio), registers its actions here with quickAction(); quickViews() makes the camera
 * action for a page that steps through views. It touches nothing at import, so any module can offer an action,
 * whether or not the page mounts the tray.
 */

export type QuickId = 'pair' | 'camera' | 'fullscreen' | 'sound' | 'theme' | 'reset'
/** The tray's order, whatever order a page offers them in. */
export const QUICK_ORDER: readonly QuickId[] = ['pair', 'camera', 'fullscreen', 'sound', 'theme', 'reset']

export interface QuickAction {
  id: QuickId
  /** Its name: the button's accessible name and the tooltip's title. */
  label: string
  /** What it does, under the name in the tooltip. */
  hint?: string
  /** An icon (ui/icons.ts), or one for its state now. */
  icon: string | (() => string)
  run(): void
  /** A switch's state now (aria-pressed), for sound or fullscreen. */
  pressed?(): boolean
  /** Keep the tray open once it has run (a switch, a camera stepping through views); else it closes. */
  stay?: boolean
}

const actions = new Map<QuickId, QuickAction>()
const listeners = new Set<(what: 'actions' | 'states') => void>()
const tell = (what: 'actions' | 'states') => { for (const l of listeners) l(what) }

/** Offer an action (again, to change it); a page's own replaces the tray's default. */
export function quickAction(action: QuickAction) {
  actions.set(action.id, action)
  tell('actions')
}
/** Offer an action unless the page already offers its own. */
export function quickDefault(action: QuickAction) {
  if (!actions.has(action.id)) quickAction(action)
}
/** Take an action out of the tray. */
export function dropQuickAction(id: QuickId) {
  actions.delete(id)
  tell('actions')
}
/** Show switches' states afresh, after a change the tray didn't make itself. */
export function quickChanged() { tell('states') }

/** The actions offered now. */
export const quickActions = (): ReadonlyMap<QuickId, QuickAction> => actions
/** Hear of changes (the tray). */
export function onQuickChange(listener: (what: 'actions' | 'states') => void) { listeners.add(listener) }

/**
 * The camera action for a page with several views: each press shows the next (the first is where the page starts),
 * and the tooltip names it.
 */
export function quickViews(views: readonly { name: string; show(): void }[]) {
  if (!views.length) return
  let at = 0
  const offer = () => quickAction({
    id: 'camera', label: 'Camera view', hint: views.length > 1 ? `Next: ${views[(at + 1) % views.length].name}` : views[0].name, icon: 'camera', stay: true,
    run: () => { at = (at + 1) % views.length; views[at].show(); offer() },
  })
  offer()
}
