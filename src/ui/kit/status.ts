/**
 * Status dots: a small light that says how something is. live (the accent, breathing), ok, warn, bad, idle (dark),
 * and rec (red, blinking, as a camera's). With a label it reads as a status line; alone it needs one from its context,
 * and gets its tone's name as a fallback. Reduced motion holds the breathing and blinking still.
 */
import '../../styles/kit.css'

export type Tone = 'live' | 'ok' | 'warn' | 'bad' | 'idle' | 'rec'

const NAMES: Record<Tone, string> = { live: 'Live', ok: 'Ready', warn: 'Attention', bad: 'Fault', idle: 'Idle', rec: 'Recording' }

/** A dot of `tone`, with `label` beside it if given. Set data-tone on the result to change it later. */
export function statusDot(tone: Tone, label?: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'kit-status'
  el.dataset.tone = tone
  const dot = document.createElement('i')
  dot.className = 'kit-dot'
  dot.setAttribute('aria-hidden', 'true')
  el.append(dot)
  const text = document.createElement('span')
  text.textContent = label ?? NAMES[tone]
  if (!label) text.className = 'kit-sr'
  el.append(text)
  return el
}
