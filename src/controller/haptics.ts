const isApple = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function hapticsKind(): 'vibrate' | 'ios-switch' | 'none' {
  if (isApple()) return 'ios-switch'
  return typeof navigator.vibrate === 'function' ? 'vibrate' : 'none'
}

let label: HTMLLabelElement | null = null

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
