/**
 * ob.Pal's glass kit: the controls every page shares, in the house style (Lime on Carbon, frosted glass, rounded
 * corners, hairline edges): the glass select, the collapsible sidebar and its rail, the bottom sheet, the segmented
 * icon control, the slider with detents, the toggle, the ring gauge and dial, the capsule gauge, the dot-matrix
 * readout and sparkline, status dots and the numbered widget card. Each works by keyboard, pointer and touch, carries
 * its ARIA roles, shows a focus ring, and holds still for reduced motion. Their look is styles/kit.css, on the family
 * tokens (src/family/family.css), so they follow the visitor's surface and accent. Pages import the parts they use;
 * the site's top bar, the viewer and the phone turn every native select into a glass one (enhanceSelects).
 */
export { GlassSelect, enhanceSelect, enhanceSelects, type SelectItem } from './select'
export { Sidebar, sidebarMode, type SidebarMode } from './sidebar'
export { Sheet } from './sheet'
export { Segmented, type SegmentItem } from './segmented'
export { DetentSlider, type Detent } from './slider'
export { toggle } from './toggle'
export { RingGauge, CapsuleGauge } from './gauge'
export { Readout, Sparkline } from './readout'
export { statusDot, type Tone } from './status'
export { widgetCard, cardHeader } from './card'
export { setPopoverFrame } from './place'
