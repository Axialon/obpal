import type { HintPosition, HintRect } from '../ui/hints'
import { uiRect, uiSize } from './uiframe'

type Frame = { size: { w: number; h: number }; pad: HintRect | null; part: HintRect | null; gestures: HintRect | null; blocked: HintRect[] }

/** Use the trackpad's empty band; other faces and occupied bands keep the existing hint placement. */
export function catalogueHintPosition(target: HintRect, bubble: HintRect, frame: Frame): HintPosition | null {
  const { pad, part, gestures, size } = frame
  if (!pad || size.w <= size.h || size.h > 520 || bubble.width <= 0 || bubble.height <= 0) return null
  const inset = 12, float = 4, caret = 8
  const top = Math.max(pad.top + inset, part ? part.top + part.height + inset : 0) + float
  const bottom = Math.min(pad.top + pad.height - inset, gestures ? gestures.top - inset : size.h)
  if (bubble.width + 2 * inset > pad.width || top + bubble.height > bottom) return null
  const side = pad.left + pad.width <= target.left ? 'left' : pad.left >= target.left + target.width ? 'right' : null
  if (!side) return null
  const left = side === 'left' ? pad.left + pad.width - inset - bubble.width : pad.left + inset
  const centre = target.top + target.height / 2
  const y = Math.max(top, Math.min(bottom - bubble.height, centre - bubble.height / 2))
  const envelope = { left: left - caret, right: left + bubble.width + caret, top: y - float, bottom: y + bubble.height }
  if (frame.blocked.some(r => envelope.right > r.left && envelope.left < r.left + r.width && envelope.bottom > r.top && envelope.top < r.top + r.height)) return null
  const arrow = Math.max(12, Math.min(bubble.height - 12, centre - y)), axis = y + arrow
  if (axis < target.top || axis - float > target.top + target.height) return null
  return { left, top: y, side, arrow, detached: true }
}

/** Measure in the same counter-rotated frame as the controller and the existing hint renderer. */
export function placeCatalogueHint(target: HintRect, bubble: HintRect): HintPosition | null {
  const pad = document.getElementById('pad')
  const visible = (el: Element | null): HintRect | null => {
    if (!(el instanceof HTMLElement) || !el.offsetParent || el.closest('[hidden]')) return null
    // An idle strip label retains padding even when it neither paints nor takes input.
    if (el.id === 'ns-tag' && !el.classList.contains('in')) {
      const style = getComputedStyle(el)
      if (Number(style.opacity) === 0 && style.pointerEvents === 'none') return null
    }
    const r = uiRect(el)
    return r.width > 0 && r.height > 0 ? r : null
  }
  return catalogueHintPosition(target, bubble, {
    size: uiSize(), pad: visible(pad), part: visible(document.getElementById('pad-part')), gestures: visible(document.getElementById('gestures')),
    blocked: [...(pad?.querySelectorAll('button, [role="button"], [role="radio"], #nstrip, #ns-tag') ?? [])].map(visible).filter((r): r is HintRect => !!r),
  })
}
