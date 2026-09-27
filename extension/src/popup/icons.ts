/** Popup-only glyphs in the same 24px stroke style as src/ui/icons.ts (which supplies the rest). */
const s = (d: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
/** A fingertip on the trackpad: the gesture pictograms draw it as a filled dot. */
const tip = (x: number, y: number, r = 3.1) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`

export const LINK_ICONS = {
  gamepad: s('<path d="M7.2 7.2h9.6a4.2 4.2 0 0 1 4.1 3.4l.9 4.6a2.5 2.5 0 0 1-4.3 2.2l-2.1-2.3H8.6l-2.1 2.3a2.5 2.5 0 0 1-4.3-2.2l.9-4.6a4.2 4.2 0 0 1 4.1-3.4Z"/><path d="M7.8 9.9v3.2M6.2 11.5h3.2"/><path d="M15.4 10.4h.01M17.4 12.4h.01" stroke-width="2.6"/>'),
  keys: s('<rect x="2.8" y="6" width="18.4" height="12" rx="2.6"/><path d="M6.6 9.6h.01M9.8 9.6h.01M13 9.6h.01M16.2 9.6h.01M6.6 12.4h.01M17.4 12.4h.01" stroke-width="2.4"/><path d="M9 14.9h6"/>'),
  globe: s('<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.3 2.3 3.4 5.2 3.4 8.6s-1.1 6.3-3.4 8.6c-2.3-2.3-3.4-5.2-3.4-8.6s1.1-6.3 3.4-8.6Z"/>'),
  tab: s('<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6"/><path d="M3.2 9h17.6"/><path d="M6.4 6.8h.01M8.9 6.8h.01" stroke-width="2.3"/>'),
  /** Through the room service. */
  cloud: s('<path d="M7.2 18.5a4.2 4.2 0 0 1-.6-8.35A5.6 5.6 0 0 1 17.4 9.2a3.9 3.9 0 0 1-.6 7.75Z"/><path d="M12 12.8v6M9.6 15.2 12 12.8l2.4 2.4"/>'),
  /** The room service out of reach. */
  cloudOff: s('<path d="M7.2 18.5a4.2 4.2 0 0 1-.6-8.35A5.6 5.6 0 0 1 17.4 9.2a3.9 3.9 0 0 1-.6 7.75Z"/><path d="M4 4l16 16"/>'),
  /** Direct over the local network: two devices, one link. */
  lan: s('<rect x="3" y="14" width="7" height="6" rx="1.8"/><rect x="14" y="14" width="7" height="6" rx="1.8"/><path d="M6.5 14v-2.4a1.6 1.6 0 0 1 1.6-1.6h7.8a1.6 1.6 0 0 1 1.6 1.6V14M12 10V6.5"/><path d="M9.2 5.2a4 4 0 0 1 5.6 0M7.2 3.2a6.8 6.8 0 0 1 9.6 0"/>'),
  /** A monitor: the PC target. */
  pc: s('<rect x="3" y="4.4" width="18" height="12.2" rx="2.4"/><path d="M12 16.6v3M8.5 19.6h7"/>'),
  mouse: s('<rect x="7.5" y="3.5" width="9" height="17" rx="4.5"/><path d="M12 3.5v5.5M7.5 9h9"/>'),
  pause: s('<rect x="6" y="5" width="4" height="14" rx="1.4"/><rect x="14" y="5" width="4" height="14" rx="1.4"/>'),
  shield: s('<path d="M12 3.2 19 6v5.4c0 4.4-3 8-7 9.4-4-1.4-7-5-7-9.4V6Z"/><path d="M9.2 12.1l1.9 1.9 3.8-3.9"/>'),
  play: s('<path d="M8 5.5v13l10-6.5Z"/>'),
  /** Something to know (the popup's notes). */
  info: s('<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2"/><path d="M12 7.8h.01" stroke-width="2.4"/>'),
  // The PC gestures, as the trackpad feels them.
  tap: s(`${tip(12, 12)}<circle cx="12" cy="12" r="7.6" opacity=".45"/>`),
  hold: s(`${tip(12, 12)}<path d="M12 4.4a7.6 7.6 0 1 1-7.6 7.6"/><path d="M4.4 12A7.6 7.6 0 0 1 12 4.4" opacity=".3"/>`),
  drag: s(`${tip(7.4, 12)}<path d="M12.4 12h8.2M17.6 9l3 3-3 3"/>`),
  scroll: s(`${tip(8.7, 12, 2.6)}${tip(15.3, 12, 2.6)}<path d="M12 2.8v3.4M9.9 4.7 12 2.6l2.1 2.1M12 21.2v-3.4M9.9 19.3l2.1 2.1 2.1-2.1"/>`),
  pinch: s(`${tip(9.4, 14.6, 2.6)}${tip(14.6, 9.4, 2.6)}<path d="M5.4 18.6 3.2 20.8M3.2 17v3.8H7M18.6 5.4l2.2-2.2M17 3.2h3.8V7"/>`),
  /** Typing: the phone's own keyboard (its tray button's glyph), a fingertip on its keys. */
  type: s(`<rect x="2.6" y="5.6" width="18.8" height="12.8" rx="2.8"/><path d="M6.2 9.4h.01M9.1 9.4h.01M12 9.4h.01M7.65 12.2h.01M10.55 12.2h.01" stroke-width="2.2"/><path d="M8.4 15.2h4.4"/>${tip(16.3, 11.3, 2.6)}`),
}
