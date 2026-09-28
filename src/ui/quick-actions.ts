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

/** One of a page's views, for the camera action. */
export interface QuickView {
  name: string
  show(): void
  /** Whether it's showing now, where the page can tell (first person entered from its own button, say). */
  current?(): boolean
  /** The phone's own view, first person, where the phone is a window into the scene. */
  phone?: boolean
}

/**
 * The camera action for a page with several views: each press shows the next (the first is where the page starts),
 * and the tooltip names it. It goes on from the view showing now where the page can tell, else from the last it
 * showed. On a touch screen the phone's own view comes straight after the first, one press away.
 */
export function quickViews(list: readonly QuickView[]) {
  if (!list.length) return
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const [first, ...rest] = list
  const views = touch ? [first, ...rest.filter((v) => v.phone), ...rest.filter((v) => !v.phone)] : list
  let at = 0
  const now = () => { const i = views.findIndex((v) => v.current?.()); return i >= 0 ? i : at }
  quickAction({
    id: 'camera', label: 'Camera view', icon: 'camera', stay: true,
    get hint() { return views.length > 1 ? `Next: ${views[(now() + 1) % views.length].name}` : views[0].name },
    run: () => { at = (now() + 1) % views.length; views[at].show() },
  })
}
