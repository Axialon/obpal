/**
 * Keyboard access for the pages' radio groups (the targets, the codes, the surfaces and the colours), after the
 * WAI-ARIA radio group pattern: a group is one stop in the tab order, its checked radio (a roving tabindex); the
 * arrow keys move to the next or the previous radio and choose it, wrapping around, and Home and End move to the
 * first and the last. Choosing is a click on the radio, so it does whatever a click does there.
 */

/** Where a key moves the focus from radio `i` of `n`, or null for a key the group leaves alone. */
export function radioStep(key: string, i: number, n: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (i + 1) % n
    case 'ArrowLeft':
    case 'ArrowUp':
      return (i - 1 + n) % n
    case 'Home':
      return 0
    case 'End':
      return n - 1
    default:
      return null
  }
}

/** Make the radios in `group` ([role=radio], checked by aria-checked) one tab stop that the arrow keys move through. */
export function radioGroup(group: HTMLElement) {
  const radios = () => [...group.querySelectorAll<HTMLElement>('[role=radio]')]
  const usable = () => radios().filter((r) => !r.hidden && !(r as HTMLButtonElement).disabled)
  const stopAt = (stop: HTMLElement | undefined) => {
    for (const r of radios()) r.tabIndex = r === stop ? 0 : -1
  }
  // The tab stop is the checked radio (the first while none is), and follows it wherever it is set from.
  const rove = () => {
    const list = usable()
    stopAt(list.find((r) => r.getAttribute('aria-checked') === 'true') ?? list[0])
  }
  group.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const list = usable()
    const i = list.indexOf(e.target as HTMLElement)
    const to = i < 0 ? null : radioStep(e.key, i, list.length)
    if (to === null) return
    e.preventDefault()
    // In a menu (the popup's look), the arrows stay in this group rather than stepping through the whole menu.
    e.stopPropagation()
    const radio = list[to]
    stopAt(radio)
    radio.focus()
    if (radio.getAttribute('aria-checked') !== 'true') radio.click()
  })
  new MutationObserver(rove).observe(group, { subtree: true, attributeFilter: ['aria-checked'] })
  rove()
}
