/**
 * SVG described as data, then written out as markup (for string callers) or built as elements. The pairing chip builds
 * elements: no innerHTML, outerHTML or DOMParser, so it works on pages that enforce Trusted Types.
 */

/** An SVG element: its tag, attributes, and children. */
export type SvgNode = [tag: string, attrs: Record<string, string | number>, children?: SvgNode[]]

const NS = 'http://www.w3.org/2000/svg'
const escape = (v: string | number) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** Markup for a node and its children. */
export function svgString([tag, attrs, children = []]: SvgNode): string {
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${escape(v)}"`).join('')
  return `<${tag}${a}>${children.map(svgString).join('')}</${tag}>`
}

/** The node and its children as elements of `doc`. */
export function svgElement([tag, attrs, children = []]: SvgNode, doc: Document = document): SVGElement {
  const el = doc.createElementNS(NS, tag) as SVGElement
  for (const [k, v] of Object.entries(attrs)) if (k !== 'xmlns') el.setAttribute(k, String(v))
  for (const c of children) el.appendChild(svgElement(c, doc))
  return el
}
