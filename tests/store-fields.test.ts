import { describe, expect, it } from 'vitest'
import { readText, baselineText, changedParagraphs, compareFields, parseListing } from './store-node.mjs'

const current = parseListing(readText('extension/store/listing.md'))
const baseline = parseListing(baselineText())
const fields = compareFields(current, baseline).flatMap((tab: { fields: { name: string; text: string; changed: boolean }[] }) => tab.fields)

describe('store update fields against submitted 1.6.2', () => {
  it('covers every permission and the separate remote code answer and explanation', () => {
    const names = fields.map((f: { name: string }) => f.name)
    for (const name of ['Name', 'Summary', 'Description', 'Single purpose', 'offscreen', 'storage', 'activeTab', 'scripting',
      'Host permission https://obpal.blackboxes.net/*', 'Optional host permission <all_urls>', 'Optional permission nativeMessaging',
      'Optional permission notifications', 'Are you using remote code?', 'Remote code explanation', 'Data usage', 'Privacy policy URL',
      'Test instructions tab (notes for the reviewer)']) expect(names).toContain(name)
    expect(new Set(names).size).toBe(names.length)
  })
  it('marks only changed field content, including changes that precede 1.7.0', () => {
    expect(fields.filter((f: { changed: boolean }) => f.changed).map((f: { name: string }) => f.name)).toEqual([
      'Description', 'storage', 'Host permission https://obpal.blackboxes.net/*', 'Test instructions tab (notes for the reviewer)',
    ])
    for (const name of ['Name', 'Summary', 'Single purpose', 'Remote code explanation', 'Data usage', 'Privacy policy URL']) {
      expect(fields.find((f: { name: string }) => f.name === name)?.changed).toBe(false)
    }
  })
  it('omits unchanged paragraphs and preserves readable before and after text', () => {
    expect(changedParagraphs('same\n\nold', 'same\n\nnew')).toEqual({ before: 'old', after: 'new' })
    expect(compareFields(parseListing('## Tab\n\n**Value:**\n\n```text\nA\n```'), parseListing('## Tab\r\n\r\n**Value:**\r\n\r\n```text\r\nA\r\n```'))[0].fields[0].changed).toBe(false)
  })
  it('keeps the reviewer field within the store limit', () => {
    expect(fields.find((f: { name: string }) => f.name.startsWith('Test instructions'))?.text.length).toBeLessThanOrEqual(500)
  })
})
