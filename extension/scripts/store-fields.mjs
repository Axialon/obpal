/** Dashboard fields and compact paragraph changes, shared by the store kit and its tests. */
export function parseListing(markdown) {
  const tabs = []
  let tab, name = '', block = false, lines = []
  const clean = s => s.replace(/^[-*\s]+/, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/[:.]\s*$/, '').trim()
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (block) {
      if (line.startsWith('```')) { tab.fields.push({ name, text: lines.join('\n') }); block = false; lines = [] }
      else lines.push(line)
      continue
    }
    if (line.startsWith('## ')) { tab = { title: line.slice(3).trim(), fields: [] }; tabs.push(tab); name = tab.title; continue }
    if (!tab || tab.title === 'Package') continue
    if (line.startsWith('```text')) { block = true; continue }
    const value = line.match(/^- ([^:`]+): `([^`]+)`/) ?? line.match(/^\*\*([^*:]+):\*\* `([^`]+)`/)
    if (value) { tab.fields.push({ name: value[1].trim(), text: value[2] }); continue }
    const setting = line.match(/^\*\*(Category|Language|Are you using remote code\?|Data usage):?\*\*:?\s*(.*)/)
    if (setting) { tab.fields.push({ name: setting[1], text: setting[2] }); name = setting[1] === 'Are you using remote code?' ? 'Remote code explanation' : setting[1]; continue }
    const plain = line.match(/^- (Official URL|Mature content|Visibility|Distribution|No in-app purchases): (.*)/)
    if (plain) { tab.fields.push({ name: plain[1], text: plain[2] }); continue }
    if (line.startsWith('- I do not ')) { tab.fields.push({ name: line.slice(2), text: 'Tick' }); continue }
    if (line.trim() && !line.startsWith('|')) name = clean(line).replace(/\s*\(.*\)$/, '')
  }
  return tabs
}

export const fieldKey = (tab, field) => `${tab.title}/${field.name}`

/** Compare exact field content after line-ending normalization; prose outside a field is not a dashboard update. */
export function compareFields(tabs, baseline) {
  const old = new Map(baseline.flatMap(tab => tab.fields.map(field => [fieldKey(tab, field), field.text])))
  return tabs.map(tab => ({ ...tab, fields: tab.fields.map(field => ({ ...field, before: old.get(fieldKey(tab, field)), changed: old.get(fieldKey(tab, field)) !== field.text })) }))
}

/** Long descriptions keep unchanged paragraphs out of the before/after view. */
export function changedParagraphs(before = '', after = '') {
  const a = before.split('\n\n'), b = after.split('\n\n')
  return { before: a.filter(p => !b.includes(p)).join('\n\n'), after: b.filter(p => !a.includes(p)).join('\n\n') }
}
