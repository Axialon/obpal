import { describe, expect, it } from 'vitest'
import { readText } from './devtools-node.mjs'

type Rect = { x: number; y: number; width: number; height: number }
type CopyNode = { nodeType: number; textContent: string; childNodes: CopyNode[]; rects: Rect[]; contains(node: CopyNode): boolean }
const node = (nodeType: number, textContent: string, childNodes: CopyNode[] = [], rects: Rect[] = []): CopyNode => ({ nodeType, textContent, childNodes, rects, contains(other) { return this === other || childNodes.some(child => child.contains(other)) } })
const text = (y: number, value = 'Label') => node(3, value, [], [{ x: 0, y, width: 100, height: 30 }])

/** Run the actual native measurement block with ink-wrapped text and Range geometry, without a browser. */
function measure(primary: CopyNode[], captions: CopyNode[]) {
  const subtitle = { ...node(1, 'Subtitle', captions), getBoundingClientRect: () => ({ x: 0, y: 60, width: 100, height: 30 }) }
  const column = { ...node(1, '', [...primary, subtitle]), querySelector: () => subtitle }
  const el = { matches: () => true, querySelector: () => column }
  const document = {
    createTreeWalker(root: CopyNode) { const all: CopyNode[] = []; const visit = (n: CopyNode) => { if (n.nodeType === 3) all.push(n); else n.childNodes.forEach(visit) }; visit(root); let index = -1; return { nextNode: () => !!all[++index], get currentNode() { return all[index] } } },
    createRange() { let selected: CopyNode; return { selectNodeContents(n: CopyNode) { selected = n }, getClientRects: () => selected.rects } },
  }
  const source = readText('scripts/phone-mobile-layout.mjs'), start = source.indexOf("      const column = el.matches('.set-row')"), end = source.indexOf('      controls.push(', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const issues: string[] = []
  const result = new Function('el', 'document', 'Node', 'NodeFilter', 'box', 'issues', 'label', `${source.slice(start, end)}; return { primary, secondary }`)(el, document, { TEXT_NODE: 3 }, { SHOW_TEXT: 4 }, (r: Rect) => r, issues, 'Settings label')
  return { ...result, issues }
}

describe('phone Settings rendered copy measurement', () => {
  it('measures ink-wrapped nested title text and detects overlap with the subtitle', () => {
    const wrapped = node(1, '', [text(0), node(1, '', [text(30)])])
    const result = measure([wrapped], [text(50, 'Subtitle')])
    expect(result.primary).toHaveLength(2)
    expect(result.secondary).toHaveLength(1)
    expect(result.issues).toContain('Settings label: primary and secondary text overlap')
  })

  it('keeps subtitle descendants out of the primary and accepts separate rendered lines', () => {
    const result = measure([node(1, '', [text(0), node(1, '', [text(30)])])], [node(1, '', [text(70, 'Subtitle')])])
    expect(result.primary).toHaveLength(2)
    expect(result.secondary).toHaveLength(1)
    expect(result.issues).toEqual([])
  })

  for (const missing of ['primary', 'subtitle']) it(`rejects missing rendered ${missing} rectangles`, () => {
    const blank = node(3, '   '), invisible = node(3, 'Text with no rendered rects')
    const result = measure(missing === 'primary' ? [node(1, '', [blank, invisible])] : [text(0)], missing === 'subtitle' ? [invisible] : [text(70, 'Subtitle')])
    expect(result.issues).toContain('Settings label: rendered primary or secondary text absent')
  })
})
