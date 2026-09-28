const isApple = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function hapticsKind(): 'vibrate' | 'ios-switch' | 'none' {
  if (!feedbackEnabled()) return 'none'
  if (isApple()) return 'ios-switch'
  return typeof navigator.vibrate === 'function' ? 'vibrate' : 'none'
}

let label: HTMLLabelElement | null = null

/** Feedback is a phone preference, independent of the screen's audio and motion preferences. */
export function feedbackEnabled() {
  try { return localStorage.getItem('obpal.feedback') !== '0' } catch { return true }
}

export function setFeedbackEnabled(on: boolean) {
  try { localStorage.setItem('obpal.feedback', on ? '1' : '0') } catch { /* private browsing */ }
  if (!on) {
    navigator.vibrate?.(0)
    for (const pad of navigator.getGamepads?.() ?? []) void pad?.vibrationActuator?.reset().catch(() => {})
  }
}

/** The phone owns these physical pads, so another participant's device never rumbles them. */
export function gamepadFeedback(strong: number, weak: number, ms: number) {
  if (!feedbackEnabled() || document.hidden) return
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad?.connected || !pad.vibrationActuator) continue
    void pad.vibrationActuator.playEffect('dual-rumble', { duration: ms, startDelay: 0, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {})
  }
}

/** Light haptic tick. Must run inside a user gesture (iOS 18+ uses the native switch haptic). */
export function tick(strong = false) {
  const kind = hapticsKind()
  if (kind === 'vibrate') {
    navigator.vibrate(strong ? 20 : 9)
  } else if (kind === 'ios-switch') {
    if (!label) {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.setAttribute('switch', '')
      input.id = 'obpal-haptic'
      input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:0;height:0'
      label = document.createElement('label')
      label.htmlFor = 'obpal-haptic'
      label.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:0;height:0'
      document.body.append(input, label)
    }
    label.click()
  }
}
