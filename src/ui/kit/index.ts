/**
 * ob.Pal's glass kit: the controls every page shares, in the house style (Lime on Carbon, frosted glass, rounded
 * corners, hairline edges): the glass select, the collapsible sidebar and its rail, the bottom sheet, the segmented
 * icon control, the slider with detents, the toggle, the ring gauge and dial, the capsule gauge, the dot-matrix
 * readout and sparkline, the telemetry instrument (a device's readout drawn as one), status dots and the numbered
 * widget card, and the notice (a short message that queues, holds while touched and dismisses). Each works by
 * keyboard, pointer and touch, carries its ARIA roles, shows a focus ring, and holds still for reduced motion. Their
 * look is styles/kit.css, on the family tokens (src/family/family.css), so they follow the visitor's surface and accent.
 * Pages import the parts they use; the site's top bar, the viewer and the phone turn
 * every native select into a glass one (enhanceSelects).
 */
export { GlassSelect, enhanceSelect, enhanceSelects, type SelectItem } from './select'
export { Sidebar, sidebarMode, type SidebarMode } from './sidebar'
export { Sheet } from './sheet'
export { Segmented, type SegmentItem } from './segmented'
export { DetentSlider, type Detent } from './slider'
export { toggle } from './toggle'
export { RingGauge, CapsuleGauge } from './gauge'
export { Readout, Sparkline } from './readout'
export { Telemetry, parseReadout } from './telemetry'
export { statusDot, type Tone } from './status'
export { notify, dismiss, calm, mountNotices, setNoticeAnchor, noticeDuration, type NoticeSpec, type NoticeTone } from './notice'
export { widgetCard, cardHeader } from './card'
export { setPopoverFrame } from './place'
