/** Constants shared by every ob.Pal Link context. Pure: nothing here touches chrome.* or the DOM. */

export const APP_NAME = 'ob.Pal Link'
/** ob.Pal room service (signaling + TURN credentials). Also the only required host permission. */
export const SERVICE = 'https://obpal.blackboxes.net'

/** Name of the runtime.connect() port a page bridge opens to the offscreen link. */
export const PORT_NAME = 'obpal-link/page'
/** window.postMessage channel id shared by the isolated-world bridge and the MAIN-world page script. */
export const CHANNEL = 'obpal-link/v1'
/** Bumped whenever the bridge <-> page protocol changes, so a stale page script replaces itself. */
export const PAGE_VERSION = 2

/** What the phone drives in the controlled tab. Index order is the wire encoding (InputFrame.m). */
export const TARGET_MODES = ['gamepad', 'viewer', 'keys'] as const
export type TargetMode = (typeof TARGET_MODES)[number]
export const DEFAULT_MODE: TargetMode = 'gamepad'

export const isTargetMode = (v: unknown): v is TargetMode =>
  typeof v === 'string' && (TARGET_MODES as readonly string[]).includes(v)

/** Visible canvas area (CSS px²) a frame needs before it wins the 3D-viewer role over the top frame. */
export const MIN_VIEW_AREA = 160 * 120
