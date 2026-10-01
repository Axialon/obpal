import { describe, expect, it } from 'vitest'
import { readText, packFiles } from './devtools-node.mjs'

/**
 * The site says only what ships (spec/MESSAGING.md, voice rule 5). These checks read the words the public meets, on the
 * pages, in the READMEs and Link's store listing, and in the specs a developer reads, and fail on an overclaim:
 *   - the npm import, while `@obpal/host` isn't on npm; once it is, words that say it isn't (or will be), and an import
 *     from a path the packages don't export
 *   - "any website" or "any browser game", unless what is tested and where the limits are stand beside it
 *   - a TV among the screens a sim opens on
 *   - macOS, unless it is "coming soon" or a preview
 *   - an emergency stop, where Stop is a software hold
 *   - the 3D position "in metres", where it comes from the camera mode or is an estimate from the phone's motion
 *   - real arms, unless they are called experimental
 * A failure names the file and the words around the hit, so the fix is a sentence and not a search.
 */

/**
 * Whether `@obpal/core` and `@obpal/host` are on npm: they are (0.1.0 went up on 2026-09-29; `pnpm run publish:npm` puts up
 * the next). While it is false the npm import is an overclaim and a README says the package isn't on npm; once it is true
 * the import is shown and "not published yet" is the overclaim.
 */
const NPM_PUBLISHED = true

/** Every page the site builds (vite.config.ts), as its file in the build. */
const PAGES = [
  'index.html', 'p/index.html', 'view/index.html', 'sponsor/index.html', 'donate/index.html', 'link/index.html', 'link/desktop/index.html', 'link/try/index.html', 'privacy/index.html',
  'sim/index.html', 'sim/arm/index.html', 'sim/arena/index.html', 'sim/device/index.html', 'catalogue/index.html', 'embed/index.html',
  'buttons/index.html', 'trust/index.html',
]

/** Store art copy is written in HTML and the screenshot captions in render.mjs. */
const STORE_ART = [
  'extension/store/src/marquee.html', 'extension/store/src/tile.html', 'extension/store/src/shot.html',
  'extension/store/src/render.mjs',
]

/** What visitors read: the pages, the summaries written for AI readers, Link's README and store listing, and the strings the scripts add. */
const PACK_COPY = packFiles()
const COPY = [
  ...PACK_COPY, 'src/catalogue/main.ts', 'src/catalogue/community.ts', 'src/catalogue/packs.ts', 'src/controller/packs.ts', 'packages/core/src/packs.ts',
  ...PAGES, 'public/llms.txt', 'public/llms-full.txt', 'extension/README.md', 'extension/store/listing.md', ...STORE_ART, 'extension/package.json',
  'extension/vite.config.ts', 'extension/src/options/options.ts', 'extension/src/popup/popup.ts', 'src/landing/main.ts',
  'src/catalogue/data.ts', 'packages/core/src/catalogue.ts', 'src/controller/main.ts', 'src/sim/arm/main.ts',
  'packages/host/src/chip.ts', 'packages/host/src/seal.ts', 'packages/host/src/origin.ts', 'packages/host/src/remote.ts', 'src/controller/linkbadge.ts',
  'src/ui/trust-origin.ts', 'src/ui/shares.ts', 'src/trust/main.ts', 'TRADEMARKS.md', 'spec/SECURITY.md',
  'src/controller/connection-sheet.ts', 'src/controller/connections.ts', 'src/controller/pairing-recovery.ts',
  'src/sim/kit/recovery.ts',
]

/** The words of `COPY` that aren't code: what the code in it imports from our own packages is no claim about npm. */
const PROSE = COPY.filter((f) => !f.endsWith('.ts') && !f.startsWith('spec/'))

/** What developers read: the repository's and the packages' READMEs and the specs, where an example is the API. */
const DOCS = [
  'spec/PACKS.md', 'CONTRIBUTING.md', ...['profiles', 'mappings', 'modes', 'scenes'].map((f) => `catalogue/${f}/README.md`),
  'README.md', 'desktop/README.md', 'packages/core/README.md', 'packages/host/README.md', 'packages/core/src/messages.ts',
  'spec/CATALOGUE.md', 'spec/PROTOCOL.md', 'spec/STYLE-3D.md', 'spec/MESSAGING.md', 'spec/SECURITY.md', 'hardware/arduino/obpal-arm/obpal-arm.ino',
]

/** The entities HTML writes that these files use. */
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', rarr: '→', larr: '←', mdash: '—', ndash: '–', hellip: '…', times: '×' }

/**
 * A file as a reader meets it: markup and Markdown syntax gone, but the words of a tag's `content`, `alt`, `title` and
 * `aria-label` kept and a link kept as [address]; entities decoded, quotes straightened, runs of space made one.
 */
function plain(file: string, source: string): string {
  let s = source
  if (PACK_COPY.includes(file)) {
    const p = JSON.parse(source)
    s = [p.id, p.version, p.name, p.description, p.author?.name, p.attribution, p.deprecated?.reason, p.kind === 'profile' ? p.body?.name : '', p.kind === 'profile' ? p.body?.for : ''].filter(Boolean).join('. ')
  }
  if (/\.(?:html|md)$/.test(file)) {
    s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<script\b(?![^>]*ld\+json)[\s\S]*?<\/script>/gi, ' ')
    s = s.replace(/<\/?[a-z][^>]*>/gi, (tag) => {
      const words = [...tag.matchAll(/\b(?:content|alt|title|aria-label)="([^"]*)"/g)].map((m) => m[1])
      const link = /\bhref="([^"]*)"/.exec(tag)?.[1]
      return ` ${words.join(' ')} ${link ? `[${link}] ` : ''}`
    })
  }
  if (file.endsWith('.md')) s = s.replace(/!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, '$1 [$2]').replace(/[`*]/g, '')
  return s
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] !== '#') return ENTITY[e] ?? all
      return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    })
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\\(['"])/g, '$1')
    .replace(/\s+/g, ' ')
}

/** One claim to watch for, and what makes it true where it is made. */
interface Rule {
  id: string
  /** What the rule keeps true, as the test names it. */
  name: string
  /** The words that make the claim. */
  claim: RegExp
  /** The files it reads. */
  files: readonly string[]
  /** True when the words near the claim, or the whole file, or the claim itself, make it right. Absent, the claim is never right. */
  ok?: (near: string, all: string, claim: string) => boolean
  /** How many characters before and after a claim count as near it (200 each by default). */
  near?: readonly [number, number]
  /** Only the first claim in each file is checked: a document says it up front. */
  once?: boolean
  /** The rule stands only while the packages are (or aren't) on npm; absent, always. */
  when?: 'published' | 'unpublished'
}

/** Where the words of these files go wrong under a rule, each as "file: …the words around the hit…". */
function violations(rule: Rule, sources: Readonly<Record<string, string>>): string[] {
  const [before, after] = rule.near ?? [200, 200]
  const found: string[] = []
  for (const [file, source] of Object.entries(sources)) {
    const text = plain(file, source)
    for (const m of text.matchAll(new RegExp(rule.claim.source, `${rule.claim.flags.replace('g', '')}g`))) {
      const at = m.index ?? 0
      const near = text.slice(Math.max(0, at - before), at + m[0].length + after)
      if (!rule.ok?.(near, text, m[0])) found.push(`${file}: …${text.slice(Math.max(0, at - 50), at + m[0].length + 60)}…`)
      if (rule.once) break
    }
  }
  return found
}

/** The text of each of these files, by name. */
const read = (files: readonly string[]) => Object.fromEntries(files.map((f) => [f, readText(f)]))

/** An import or an install line for a package of ours (`import … from '@obpal/host'`, `npm install @obpal/core`). */
const NPM_LINE = /(?:\bfrom|\bimport\s*\(?)\s*['"]@obpal\/|\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+@obpal\//
/** A sentence that says the package isn't on npm yet. */
const NOT_PUBLISHED = /\bnot (?:yet )?published\b|\b(?:isn't|is not) (?:on npm|published)\b|\bnot on npm\b|\bunpublished\b/i
/** Words that put the packages off npm, or say they will be there: false once they are. Read with what is said about npm near them. */
const NOT_ON_NPM = new RegExp([
  String.raw`\b(?:not|isn't|aren't|is not|are not)(?: yet)? (?:published|on npm|available on npm)\b`,
  String.raw`\bunpublished\b`,
  String.raw`\b(?:coming|soon)\b[^.]{0,40}\bnpm\b`,
  String.raw`\bnpm\b[^.]{0,40}\b(?:coming|soon)\b`,
  String.raw`\bonce (?:it|they)(?: is|'s| are|'re) (?:live|published|on npm)\b`,
  String.raw`\buntil\b[^.]{0,60}\bis on npm\b`,
].join('|'), 'i')
/** The import paths the packages export (their package.json `exports`): `@obpal/core`, `@obpal/host/element`, and so on. */
const ENTRY_POINTS = new Set(['core', 'host'].flatMap((p) => Object.keys(JSON.parse(readText(`packages/${p}/package.json`)).exports as Record<string, unknown>).map((k) => `@obpal/${p}${k.slice(1)}`)))
/** A broad claim's qualifier is two things: what is tested, and where the limits are (a link to them, or the word). */
const TESTED = /\btested\b/i
const LIMITS = /\blimit(?:s|ations)?\b/i
/** How macOS is put where it isn't shipped. */
const NOT_SHIPPED = /coming soon|preview/i

/** Trust copy includes developer notes, where an attack or a limitation may be explained without making a promise. */
const TRUST_COPY = [...COPY, 'README.md']
/** Explicitly negative wording, kept close enough that another sentence cannot qualify an affirmative claim. */
const NEGATIVE_PROOF = /\b(?:not|never|no|isn't|doesn't|cannot|can't)(?: (?:a|an|the|any|independent|conclusive|absolute|certificate|or|and)){0,6} (?:proof|prove(?:s)?|guarantee(?:s|d)?|guaranteed|certif(?:y|ies))\b$/i
const NEGATIVE_CAMERA = /\b(?:never|not|no|don't|doesn't)(?: (?:uploaded|recorded|sent|or|nor|and)){0,5} (?:upload(?:ed|s)?|record(?:ed|s)?|sent|send)\b$/i
/** Only the current sentence may negate a claim; a disclaimer in an earlier sentence is not enough. */
const negated = (near: string, claim: string, negative: RegExp) => negative.test(`${near.slice(0, -claim.length).split(/[.!?;]/).at(-1) ?? ''}${claim}`.replace(/,\s*/g, ' '))

const RULES: Rule[] = [
  { id: 'link-viewers', name: 'Link never promises every 3D viewer', claim: /\bany 3D viewer/i, files: COPY },
  { id: 'link-panic', name: 'Link panic copy names phone input rather than all activity', claim: /\bstops (?:everything|it all)\b/i, files: ['link/index.html', 'link/desktop/index.html', 'extension/store/listing.md', ...STORE_ART, 'extension/src/popup/popup.ts', 'extension/src/options/options.ts'] },
  { id: 'link-rumble', name: 'Link rumble copy qualifies phone and browser support', claim: /\brumble(?: reaches your phone| works|[.!])?/i, files: ['link/index.html', 'extension/store/listing.md', ...STORE_ART], near: [120, 160], ok: near => /\b(?:vibration|supported|support)\b/i.test(near) },
  { id: 'pack-status', name: 'pack display text cannot claim project status', files: PACK_COPY,
    claim: /\bofficial\b|\b(?:approved|endorsed|certified|verified)\s+(?:by\s+)?ob[. ]?pal\b|\bob[. ]?pal\s+(?:approved|endorsed|certified|verified)\b/i },
  { id: 'npm-copy', name: 'no page or listing shows the npm import while the package is unpublished', claim: NPM_LINE, files: PROSE, when: 'unpublished' },
  {
    id: 'npm-docs', name: 'a README or spec that shows the npm import says the package isn’t on npm yet',
    claim: NPM_LINE, files: DOCS, ok: (_, all) => NOT_PUBLISHED.test(all), when: 'unpublished',
  },
  {
    id: 'npm-stale', name: 'no page, listing, README or spec says the packages are not on npm, or soon will be',
    claim: NOT_ON_NPM, files: [...COPY, ...DOCS], near: [120, 120], ok: (near) => !/\bnpm\b|@obpal\//i.test(near), when: 'published',
  },
  {
    id: 'npm-entries', name: 'an import from our packages names a path they export',
    claim: /@obpal\/(?:core|host)(?:\/[\w-]+)*/, files: [...COPY, ...DOCS], ok: (_near, _all, claim) => ENTRY_POINTS.has(claim),
  },
  {
    id: 'broad', name: '“any website” and “any browser game” come with what is tested and a link to the limits',
    claim: /\bany (?:web ?site|browser game)s?\b/i, files: [...COPY, ...DOCS], near: [220, 340], ok: (near) => TESTED.test(near) && LIMITS.test(near),
  },
  { id: 'tv', name: 'no page or listing offers a TV as a screen for a sim', claim: /\bTVs?\b/, files: COPY },
  { id: 'mac-copy', name: 'macOS is “coming soon” or a preview wherever a page or a listing mentions it', claim: /\bmacOS\b/, files: COPY, ok: (near) => NOT_SHIPPED.test(near) },
  {
    id: 'mac-docs', name: 'a README or spec says up front that macOS is a preview',
    claim: /\bmacOS\b/, files: DOCS, near: [400, 400], once: true, ok: (near) => NOT_SHIPPED.test(near),
  },
  {
    id: 'stop', name: 'an emergency stop is called a software hold wherever it is named',
    claim: /\be-stop\b|\b(?:a machine's own |(?:its )?power switch or )?emergency[- ]stop\b|\bsafety stop\b/i, files: [...COPY, ...DOCS], near: [240, 240],
    ok: (near, _all, claim) => /\bsoftware hold\b/i.test(near) || /\ba machine's own |\bpower switch or /i.test(claim),
  },
  { id: 'metres', name: 'the 3D position is never given “in metres”', claim: /\bin met(?:re|er)s\b/i, files: COPY },
  {
    id: 'real-arms', name: 'real arms are called experimental wherever a page offers them',
    claim: /\breal[- ]arms?\b/i, files: PROSE, near: [300, 300], ok: (near) => /\bexperimental\b/i.test(near),
  },
  {
    id: 'seal-proof', name: 'a seal or marker never promises a legitimate build or guaranteed security', files: TRUST_COPY,
    claim: /\b(?:seal|marker|badge)\b[^.!?]{0,90}\b(?:guarantee(?:s|d)?|certif(?:y|ies)|prove(?:s)?|(?:is|offers|gives|provides) (?:a |the |conclusive |absolute )?proof)\b|\b(?:guaranteed|100%|completely|perfectly) (?:safe|secure|private|authentic)\b/i,
    near: [25, 0], ok: (near, _all, claim) => negated(near, claim, NEGATIVE_PROOF),
  },
  {
    id: 'marker-removable', name: 'the fork marker is never described as impossible to remove or forge', files: TRUST_COPY,
    claim: /\b(?:marker|badge)\b[^.!?]{0,60}\b(?:cannot|can't|can never|impossible to)\b[^.!?]{0,30}\b(?:remove|hide|copy|forge)[\w]*\b|\b(?:tamper-proof|unremovable|unforgeable) (?:marker|badge)\b/i,
  },
  {
    id: 'storage-absolute', name: 'copy never says that nothing is stored when local pairings and preferences are kept', files: TRUST_COPY,
    claim: /\b(?:nothing(?: else)?|no data|no information) (?:(?:is|are|gets?|ever) ){0,2}(?:stored|saved|kept)\b|\bwe (?:never|don't|do not) (?:store|save|keep) (?:anything|any data)\b/i,
  },
  {
    id: 'camera-upload', name: 'camera frames are never offered for upload or recording, even with permission', files: TRUST_COPY,
    claim: /\bcamera (?:frames|images)\b[^.!?]{0,90}\b(?:upload(?:ed|s)?|record(?:ed|s)?|sent to (?:our |the )?(?:server|cloud))\b|\b(?:upload(?:ed|s)?|record(?:ed|s)?)\b[^.!?]{0,60}\bcamera (?:frames|images)\b/i,
    near: [30, 0], ok: (near, _all, claim) => negated(near, claim, NEGATIVE_CAMERA),
  },
  {
    id: 'pending-diagnosis', name: 'pending pairing copy does not diagnose an unknown network cause', files: COPY,
    claim: /\b(?:still connecting|waiting for the screen)\b[^.!?]{0,100}\b(?:because|due to|caused by|blocked by)\b/i,
  },
  {
    id: 'host-storage', name: 'copy makes no storage promise for the apps and integrations a person controls', files: TRUST_COPY,
    claim: /\b(?:hosts?|screens?|integrations?|websites?|apps?|both devices)\b[^.!?]{0,45}\b(?:cannot|can't|can never|never|doesn't|does not|do not)\b[^.!?]{0,25}\b(?:store|record|log|keep)\b[^.!?]{0,25}\b(?:input|typing|controls?)\b|\bno (?:host|screen|integration|website|app) can (?:store|record|log|keep) (?:input|typing)\b/i,
  },
]

describe('overclaims', () => {
  for (const rule of RULES) {
    // The npm import is allowed once the packages are published, and then the words that say they aren't are not; the rest stand.
    const applies = !rule.when || (rule.when === 'published') === NPM_PUBLISHED
    it.skipIf(!applies)(rule.name, () => {
      expect(violations(rule, read(rule.files))).toEqual([])
    })
  }

  it('each rule stops the claim it names and lets the qualified wording through', () => {
    const count = (id: string, file: string, text: string) => violations(RULES.find((r) => r.id === id)!, { [file]: text }).length
    // The npm import, and the embed snippet in its place.
    expect(count('npm-copy', 'a.html', `<pre>import { Remote } from <span class="s">'@obpal/host'</span></pre>`)).toBe(1)
    expect(count('npm-copy', 'a.md', 'npm install @obpal/host')).toBe(1)
    expect(count('npm-copy', 'a.html', `<pre>&lt;script type="module" src="https://obpal.blackboxes.net/embed.js"&gt;</pre>`)).toBe(0)
    expect(count('npm-docs', 'a.md', 'Not published yet. When it is:\n```\nimport { Remote } from \'@obpal/host\'\n```')).toBe(0)
    expect(count('npm-docs', 'a.md', '```\nimport { Remote } from \'@obpal/host\'\n```')).toBe(1)
    // Once they are on npm: the words that say they aren't, or will be, and a path they don't export.
    expect(count('npm-stale', 'a.md', 'Not published yet. When it is:\n```\nnpm install @obpal/host\n```')).toBe(1)
    expect(count('npm-stale', 'a.md', 'The packages aren\'t on npm yet, so pages use the embed.')).toBe(1)
    expect(count('npm-stale', 'a.html', '<p>The SDK is coming to npm.</p>')).toBe(1)
    expect(count('npm-stale', 'a.md', 'The Chrome Web Store and npm once they\'re live.')).toBe(1)
    expect(count('npm-stale', 'a.md', 'Link is not yet published on the Chrome Web Store.')).toBe(0)
    expect(count('npm-stale', 'a.md', 'npm install @obpal/host, and the embed if you would rather not build.')).toBe(0)
    expect(count('npm-entries', 'a.md', 'import { threeObject } from \'@obpal/host/adapters\'')).toBe(1)
    expect(count('npm-entries', 'a.md', 'import { defineObpalRemote } from \'@obpal/host/element\'')).toBe(0)
    expect(count('npm-entries', 'a.md', 'import { TossDetector } from \'@obpal/core/toss\'')).toBe(0)
    // A broad claim, in a heading and in a description, and with its qualifier.
    expect(count('broad', 'a.html', '<h1>Your phone controls any website.</h1>')).toBe(1)
    expect(count('broad', 'extension/store/src/render.mjs', "title: 'Your phone controls *any website*'")).toBe(1)
    expect(count('broad', 'a.html', '<meta name="description" content="Gamepad, 3D mouse or keys for any website." />')).toBe(1)
    expect(count('broad', 'a.md', 'Four phones: any browser game that reads the Gamepad API.')).toBe(1)
    expect(count('broad', 'a.html', '<h1>Your phone controls any website.</h1><p>Tested in Chrome and Edge. <a href="https://example.com/#limitations">The limits</a>.</p>')).toBe(0)
    // A TV, macOS, an emergency stop, metres and real arms.
    expect(count('tv', 'a.html', '<p>Open a sim on a computer or TV and scan its code.</p>')).toBe(1)
    expect(count('tv', 'a.html', '<p>Open a sim on a computer and scan its code.</p>')).toBe(0)
    expect(count('mac-copy', 'a.html', '<p>Windows and macOS.</p>')).toBe(1)
    expect(count('mac-copy', 'a.html', '<p>Windows now. macOS is coming soon.</p>')).toBe(0)
    expect(count('mac-docs', 'a.md', 'Windows and macOS (Intel and Apple Silicon).')).toBe(1)
    expect(count('mac-docs', 'a.md', 'Windows, and a macOS preview that is awaiting a first Mac test.')).toBe(0)
    expect(count('stop', 'a.html', '<p>The e-stop holds it where it is.</p>')).toBe(1)
    expect(count('stop', 'a.html', '<p>Stop is a software hold, not an emergency stop.</p>')).toBe(0)
    expect(count('stop', 'a.md', "A machine's own emergency stop stays within reach.")).toBe(0)
    expect(count('metres', 'a.html', '<code>// the hand, in metres</code>')).toBe(1)
    expect(count('real-arms', 'a.html', '<p>Built for real arms.</p>')).toBe(1)
    expect(count('real-arms', 'a.html', '<p>Real arms are experimental, and not yet tested on hardware.</p>')).toBe(0)
    // A nearby disclaimer cannot excuse an affirmative guarantee, or a permission-based camera upload.
    expect(count('seal-proof', 'a.html', '<p>The seal proves this is an official build.</p>')).toBe(1)
    expect(count('seal-proof', 'a.html', '<p>The seal is proof of an official build.</p>')).toBe(1)
    expect(count('seal-proof', 'a.md', 'The seal guarantees security. It is a comparison aid.')).toBe(1)
    expect(count('seal-proof', 'a.md', 'Not proof of identity. The seal guarantees security.')).toBe(1)
    expect(count('seal-proof', 'a.md', 'The seal is not proof of identity and guarantees security.')).toBe(1)
    expect(count('seal-proof', 'a.md', 'The seal is a comparison aid, not proof that a build is legitimate.')).toBe(0)
    expect(count('seal-proof', 'a.md', 'A seal is never a guarantee of authenticity.')).toBe(0)
    expect(count('seal-proof', 'a.md', 'The badge shows only on a bound link, and binding takes that proof.')).toBe(0)
    expect(count('marker-removable', 'a.ts', "label: 'The official marker cannot be removed'")).toBe(1)
    expect(count('marker-removable', 'a.html', '<p>A malicious copy can remove the marker.</p>')).toBe(0)
    expect(count('storage-absolute', 'a.html', '<h1>Nothing else is kept.</h1>')).toBe(1)
    expect(count('storage-absolute', 'a.ts', "note: 'No data is ever stored'")).toBe(1)
    expect(count('storage-absolute', 'a.md', 'Control input is not stored. Saved screens and preferences stay on this device.')).toBe(0)
    expect(count('camera-upload', 'a.html', '<p>Camera frames are uploaded only with your permission.</p>')).toBe(1)
    expect(count('camera-upload', 'a.md', 'Camera frames are never uploaded or recorded.')).toBe(0)
    expect(count('camera-upload', 'a.md', 'Camera frames are never uploaded. Camera frames are recorded with consent.')).toBe(1)
    expect(count('camera-upload', 'a.md', 'Camera frames are never uploaded but are recorded locally.')).toBe(1)
    expect(count('host-storage', 'a.html', '<p>No host can store input.</p>')).toBe(1)
    expect(count('pending-diagnosis', 'a.ts', 'Still connecting because your firewall blocks the connection.')).toBe(1)
    expect(count('pending-diagnosis', 'a.ts', "Still connecting. Keep the screen's ob.Pal page open.")).toBe(0)
    expect(count('host-storage', 'a.md', 'Websites never record your typing.')).toBe(1)
    expect(count('host-storage', 'a.md', 'Control input is not stored by ob.Pal. An integration decides what its own page does with input.')).toBe(0)
  })

  it('keeps every trust promise tied to its implementation or privacy explanation', () => {
    const html = readText('trust/index.html')
    const backings: Record<string, readonly string[]> = {
      accounts: ['worker/index.ts'], tracking: ['vite.config.ts'], telemetry: ['wrangler.jsonc'],
      feedback: ['/privacy/#contact'], camera: ['src/controller/scanner.ts', 'tests/scanner.test.ts'],
      open: ['LICENSE', 'TRADEMARKS.md'],
    }
    for (const [promise, links] of Object.entries(backings)) {
      const row = new RegExp(`<li id="promise-${promise}">([\\s\\S]*?)</li>`).exec(html)?.[1]
      expect(row, promise).toBeDefined()
      for (const link of links) expect(row, promise).toContain(link.startsWith('/') ? `href="${link}"` : `href="https://github.com/Axialon/obpal/blob/main/${link}"`)
    }
    expect(html).toContain('Saved screens and preferences stay on this device.')
    expect(html).toContain('A malicious copy can remove the marker.')
    expect(html).toContain('Check both screens show the same seal.')
    const popup = readText('extension/src/popup/popup.ts')
    const scan = /<div class="scan" id="scan">([\s\S]*?)<div class="codes"/.exec(popup)?.[1]
    expect(scan).toContain('id="qr"')
    expect((scan ?? "").replaceAll("’", "'")).toContain("phone's browser · no app · no account")
    expect(scan).toContain('obpal.blackboxes.net')
    expect(scan).toContain('Check your camera shows obpal.blackboxes.net')
    expect(popup).toContain('Check both screens show the same seal')
    expect(readText('wrangler.jsonc')).toMatch(/"invocation_logs"\s*:\s*false/)
    // A new endpoint or remote script requires reviewing the no-tracking promise, rather than silently expanding it.
    const service = readText('worker/index.ts')
    expect([...service.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1])).toEqual(['/api/health', '/api/ice', '/api/code', '/sim/device/'])
    expect(service).toContain('PAYMENT_ROUTES.includes(url.pathname)')
    expect(readText('worker/payments.ts')).toContain("PAYMENT_ROUTES = ['/api/payments/config', '/api/donations/live', '/api/checkout', '/api/donate', '/api/webhooks/stripe', '/api/webhooks/sponsors']")
    expect(readText('vite.config.ts')).toContain("'script-src': [\"'self'\"]")
    expect(readText('src/controller/scanner.ts')).toMatch(/getUserMedia\(\{ audio: false, video:/)
    expect(readText('src/controller/main.ts')).toContain('if (scanArrival) openConnections()')
    expect(readText('src/controller/main.ts')).not.toContain('catch(() => openConnections(true))')
    for (const file of ['src/controller/scanner.ts', 'src/controller/hand-worker.ts', 'src/controller/body-worker.ts']) {
      expect(readText(file), file).not.toMatch(/\bMediaRecorder\b|\.addTrack\(|\bsendBeacon\b|\bXMLHttpRequest\b|\bWebSocket\b|method:\s*['"]POST['"]/)
    }
    expect(readText('packages/core/src/store.ts')).toContain("createObjectStore('connections'")
    expect(readText('packages/core/src/store.ts')).toContain("createObjectStore('pairs'")
  })
})
