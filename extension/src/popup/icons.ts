/** Popup-only glyphs in the same 24px stroke style as src/ui/icons.ts (which supplies the rest). */
const s = (d: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`

export const LINK_ICONS = {
  gamepad: s('<path d="M7.2 7.2h9.6a4.2 4.2 0 0 1 4.1 3.4l.9 4.6a2.5 2.5 0 0 1-4.3 2.2l-2.1-2.3H8.6l-2.1 2.3a2.5 2.5 0 0 1-4.3-2.2l.9-4.6a4.2 4.2 0 0 1 4.1-3.4Z"/><path d="M7.8 9.9v3.2M6.2 11.5h3.2"/><path d="M15.4 10.4h.01M17.4 12.4h.01" stroke-width="2.6"/>'),
  keys: s('<rect x="2.8" y="6" width="18.4" height="12" rx="2.6"/><path d="M6.6 9.6h.01M9.8 9.6h.01M13 9.6h.01M16.2 9.6h.01M6.6 12.4h.01M17.4 12.4h.01" stroke-width="2.4"/><path d="M9 14.9h6"/>'),
  globe: s('<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.3 2.3 3.4 5.2 3.4 8.6s-1.1 6.3-3.4 8.6c-2.3-2.3-3.4-5.2-3.4-8.6s1.1-6.3 3.4-8.6Z"/>'),
  tab: s('<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6"/><path d="M3.2 9h17.6"/><path d="M6.4 6.8h.01M8.9 6.8h.01" stroke-width="2.3"/>'),
  /** Through the room service. */
  cloud: s('<path d="M7.2 18.5a4.2 4.2 0 0 1-.6-8.35A5.6 5.6 0 0 1 17.4 9.2a3.9 3.9 0 0 1-.6 7.75Z"/><path d="M12 12.8v6M9.6 15.2 12 12.8l2.4 2.4"/>'),
  /** Direct over the local network: two devices, one link. */
  lan: s('<rect x="3" y="14" width="7" height="6" rx="1.8"/><rect x="14" y="14" width="7" height="6" rx="1.8"/><path d="M6.5 14v-2.4a1.6 1.6 0 0 1 1.6-1.6h7.8a1.6 1.6 0 0 1 1.6 1.6V14M12 10V6.5"/><path d="M9.2 5.2a4 4 0 0 1 5.6 0M7.2 3.2a6.8 6.8 0 0 1 9.6 0"/>'),
  /** A monitor: the PC target. */
  pc: s('<rect x="3" y="4.4" width="18" height="12.2" rx="2.4"/><path d="M12 16.6v3M8.5 19.6h7"/>'),
  mouse: s('<rect x="7.5" y="3.5" width="9" height="17" rx="4.5"/><path d="M12 3.5v5.5M7.5 9h9"/>'),
  pause: s('<rect x="6" y="5" width="4" height="14" rx="1.4"/><rect x="14" y="5" width="4" height="14" rx="1.4"/>'),
  shield: s('<path d="M12 3.2 19 6v5.4c0 4.4-3 8-7 9.4-4-1.4-7-5-7-9.4V6Z"/><path d="M9.2 12.1l1.9 1.9 3.8-3.9"/>'),
  play: s('<path d="M8 5.5v13l10-6.5Z"/>'),
}
