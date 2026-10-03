/** The source-only template catalogue, and the DOM adaptation of sims owned by another work lane. */
import { parseSync } from 'vite'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function children(node) {
  return Object.values(node).flatMap((v) => Array.isArray(v) ? v.filter((n) => n?.type) : v?.type ? [v] : [])
}
const markup = (s) => /<\/?[a-z][\w-]*(?:\s|>|\/)/i.test(s)

/** Convert literal templates and their sinks, keeping expressions as DOM values. Also used for the initial migration. */
export function domTemplates(code, id) {
  const ast = parseSync(id, code).program
  const used = new Set()
  const use = (name) => { used.add(name); return name }
  const original = (n) => code.slice(n.start, n.end)
  const literal = (n) => n.type === 'Literal' && typeof n.value === 'string'
  const isHTML = (n) => literal(n) ? markup(n.value) : n.type === 'TemplateLiteral' && n.quasis.some((q) => markup(q.value.cooked))
  const flatten = (n) => n.type === 'BinaryExpression' && n.operator === '+' ? [...flatten(n.left), ...flatten(n.right)] : [n]
  const escaped = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  function render(n, inTemplate = false) {
    if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'MemberExpression' && n.left.property.name === 'innerHTML') {
      if (literal(n.right) && n.right.value === '') return `${render(n.left.object)}.replaceChildren()`
      return `${use('_setMarkup')}(${render(n.left.object)}, ${render(n.right, true)})`
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'insertAdjacentHTML') {
      return `${use('_insertMarkup')}(${render(n.callee.object)}, ${n.arguments.map((a) => render(a, true)).join(', ')})`
    }
    if (inTemplate && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'join' && n.arguments.length === 1 && literal(n.arguments[0]) && n.arguments[0].value === '') {
      return `${use('_joinMarkup')}(${render(n.callee.object, true)})`
    }
    if (inTemplate && n.type === 'CallExpression' && n.callee.name === 'esc' && n.arguments.length === 1) return render(n.arguments[0])
    if (inTemplate && n.type === 'BinaryExpression' && n.operator === '+' && flatten(n).some(isHTML)) {
      return use('_html') + '`' + flatten(n).map((v) => literal(v) ? escaped(v.value) : '${' + render(v, true) + '}').join('') + '`'
    }
    if (inTemplate && isHTML(n)) {
      if (literal(n)) return use('_html') + '`' + escaped(n.value) + '`'
      return use('_html') + '`' + n.quasis.map((q, i) => q.value.raw + (i < n.expressions.length ? '${' + render(n.expressions[i], true) + '}' : '')).join('') + '`'
    }
    const edits = children(n).map((c) => [c.start, c.end, render(c, inTemplate)]).sort((a, b) => b[0] - a[0])
    let out = original(n)
    for (const [start, end, text] of edits) out = out.slice(0, start - n.start) + text + out.slice(end - n.start)
    return out
  }
  const result = code.slice(0, ast.start) + render(ast) + code.slice(ast.end)
  if (!used.size) return result
  return `import { ${[...used].map((n) => `${n.slice(1)} as ${n}`).join(', ')} } from '/src/ui/markup'\n` + result
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(resolve(dir, e.name)) : /\.(ts|js)$/.test(e.name) ? [resolve(dir, e.name)] : [])
}

export function templateCatalogue(root) {
  const out = new Set()
  // Only these code-owned vector assets may enter the DOM template policy as raw markup.
  for (const file of ['public/logo-mark.svg', 'public/brand/obpal-link-lockup.svg']) out.add(readFileSync(resolve(root, file), 'utf8'))
  for (const path of files(resolve(root, 'src'))) {
    if (path.endsWith('.d.ts')) continue
    let code = readFileSync(path, 'utf8')
    if (path.replaceAll('\\', '/').includes('/src/sim/')) code = domTemplates(code, path)
    const visit = (n) => {
      // The public icon vocabulary remains strings for the sims' source API. Only these exact code literals parse.
      if (path.replaceAll('\\', '/').endsWith('/src/ui/icons.ts') && n.type === 'CallExpression' && n.callee.name === 's' && n.arguments[0]?.type === 'Literal') {
        out.add(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${n.arguments[0].value}</svg>`)
      }
      if (n.type === 'Literal' && typeof n.value === 'string' && n.value.startsWith('<svg')) out.add(n.value)
      if (n.type === 'VariableDeclarator' && n.id.name === 'LOGO_WORD') out.add(n.init.quasis[0].value.cooked)
      if (n.type === 'TaggedTemplateExpression' && ['_html', 'html'].includes(n.tag.name)) {
        const skeleton = n.quasi.quasis.map((q, i) => q.value.cooked + (i < n.quasi.expressions.length ? `obpal-slot-${i}-end` : '')).join('')
        out.add(skeleton)
        out.add(`<svg>${skeleton}</svg>`)
      }
      for (const c of children(n)) visit(c)
    }
    visit(parseSync(path, code).program)
  }
  return [...out]
}

export function markupBuild(root) {
  return {
    name: 'obpal-dom-templates', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:obpal-templates') return '\0' + id },
    load(id) { if (id === '\0virtual:obpal-templates') return `export default ${JSON.stringify(templateCatalogue(root))}` },
    transform(code, id) {
      if (id.replaceAll('\\', '/').includes('/src/sim/') && /\.(ts|js)$/.test(id) && /innerHTML|insertAdjacentHTML/.test(code)) return domTemplates(code, id)
    },
    handleHotUpdate(ctx) {
      if (!ctx.file.replaceAll('\\', '/').includes('/src/') || !/\.(ts|js)$/.test(ctx.file)) return
      const catalogue = ctx.server.moduleGraph.getModuleById('\0virtual:obpal-templates')
      if (catalogue) ctx.server.moduleGraph.invalidateModule(catalogue)
      ctx.server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}
