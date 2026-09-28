/**
 * The toggle: a switch that's on (the accent track, the knob to the right) or off. It's a native checkbox with the
 * switch role, so Space flips it, forms read it, and a label names it; styles/kit.css draws it. Any checkbox given
 * the class kit-switch (and role="switch") looks the same.
 */
import '../../styles/kit.css'

export interface ToggleOptions {
  label: string
  checked?: boolean
  /** Keep the name for assistive tech only. */
  hideLabel?: boolean
  onChange?: (on: boolean) => void
}

/** A labelled switch; its input is `.querySelector('input')`. */
export function toggle({ label, checked = false, hideLabel = false, onChange }: ToggleOptions): HTMLLabelElement {
  const row = document.createElement('label')
  row.className = 'kit-toggle'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'kit-switch'
  input.setAttribute('role', 'switch')
  input.checked = checked
  input.addEventListener('change', () => onChange?.(input.checked))
  const text = document.createElement('span')
  text.textContent = label
  if (hideLabel) text.className = 'kit-sr'
  row.append(input, text)
  return row
}
