/// <reference path="./templates.d.ts" />
/** Code-owned templates. Values become text, attributes or nested DOM, never input to the HTML policy. */
import templates from 'virtual:obpal-templates'

const allowed = new Set(templates)
const svgNS = 'http://www.w3.org/2000/svg'
const marker = (i: number) => `obpal-slot-${i}-end`
const slots = /obpal-slot-(\d+)-end/g

/** Only skeletons extracted from our source at build time may reach the HTML parser. */
export function guardMarkup(value: string): string {
  if (!allowed.has(value)) throw new TypeError('Not an ob.Pal template')
  return value
}

/** The controller's own offline worker is the only script URL this policy can issue. */
export function guardScriptURL(value: string): string {
  if (value !== '/p/sw.js') throw new TypeError('Not an ob.Pal script URL')
  return value
}

type Policy = { createHTML(s: string): unknown; createScriptURL(s: string): unknown }
let policy: Policy | undefined
function ownPolicy(): Policy | undefined {
  const tt = (globalThis as typeof globalThis & { trustedTypes?: { createPolicy(name: string, rules: { createHTML(s: string): string; createScriptURL(s: string): string }): Policy } }).trustedTypes
  if (tt) policy ??= tt.createPolicy('obpal-templates', { createHTML: guardMarkup, createScriptURL: guardScriptURL })
  return policy
}
function trusted(s: string): string {
  return (ownPolicy()?.createHTML(s) ?? guardMarkup(s)) as string
}

export function controllerWorkerURL(): string { return (ownPolicy()?.createScriptURL('/p/sw.js') ?? '/p/sw.js') as string }

export class Markup {
  constructor(readonly strings: readonly string[], readonly values: readonly Content[]) {}
  toString(): never { throw new TypeError('Compose templates as DOM, not strings') }
}
export type Content = Markup | Node | string | number | boolean | null | undefined | readonly Content[]

export function html(strings: TemplateStringsArray, ...values: Content[]): Markup {
  return new Markup(strings, values)
}

/** Lists compose as DOM; unlike Array.join, this never coerces a template into a string. */
export function joinMarkup(values: readonly Content[], separator: Content = ''): Content[] {
  return values.flatMap((v, i) => i ? [separator, v] : [v])
}

function fragment(value: Content, svg = false): DocumentFragment {
  const result = document.createDocumentFragment()
  if (value == null || value === false) return result
  if (Array.isArray(value)) { for (const v of value) result.append(fragment(v, svg)); return result }
  if (value instanceof Node) { result.append(value); return result }
  if (typeof value === 'string' && allowed.has(value)) value = new Markup([value], [])
  if (!(value instanceof Markup)) { result.append(document.createTextNode(String(value))); return result }
  const skeleton = value.strings.map((s, i) => s + (i < value.values.length ? marker(i) : '')).join('')
  const template = document.createElement('template')
  template.innerHTML = trusted(svg ? `<svg>${skeleton}</svg>` : skeleton)
  const root = svg ? template.content.firstElementChild! : template.content
  const walk = (parent: Node) => {
    for (const child of [...parent.childNodes]) {
      if (child instanceof Element) {
        for (const a of [...child.attributes]) {
          if (a.name.includes('obpal-slot-')) throw new TypeError('Template attributes must have static names')
          if (!a.value.includes('obpal-slot-')) continue
          if (/^on/i.test(a.name) || /^(srcdoc|is)$/i.test(a.name)) throw new TypeError('Executable template attribute')
          const text = a.value.replace(slots, (_, n) => String(value.values[Number(n)] ?? ''))
          if (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*(javascript|vbscript):/i.test(text.replace(/[\u0000-\u0020]/g, ''))) throw new TypeError('Executable template URL')
          if (/^(checked|disabled|hidden|selected|multiple|readonly|required)$/.test(a.name) && /^obpal-slot-\d+-end$/.test(a.value)) {
            child.toggleAttribute(a.name, !!value.values[Number(a.value.match(/\d+/)![0])])
          } else child.setAttributeNS(a.namespaceURI, a.name, text)
        }
        walk(child)
      } else if (child.nodeType === Node.TEXT_NODE && child.textContent?.includes('obpal-slot-')) {
        const text = child.textContent
        const nodes = document.createDocumentFragment()
        let at = 0
        for (const m of text.matchAll(slots)) {
          nodes.append(document.createTextNode(text.slice(at, m.index)))
          nodes.append(fragment(value.values[Number(m[1])], parent instanceof Element && parent.namespaceURI === svgNS))
          at = m.index! + m[0].length
        }
        nodes.append(document.createTextNode(text.slice(at)))
        parent.replaceChild(nodes, child)
      }
    }
  }
  walk(root)
  result.append(...root.childNodes)
  return result
}

export function setMarkup(el: Element, value: Content) { el.replaceChildren(fragment(value, el.namespaceURI === svgNS)) }
export function insertMarkup(el: Element, position: InsertPosition, value: Content) {
  const nodes = fragment(value, el.namespaceURI === svgNS)
  if (position === 'afterbegin') el.prepend(nodes)
  else if (position === 'beforeend') el.append(nodes)
  else if (position === 'beforebegin') el.before(nodes)
  else el.after(nodes)
}
