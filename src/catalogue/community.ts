/** The community list and its credits share the same checked catalogue as the phone. */
import { packCredit, type Pack } from '@obpal/core'
import { html, setMarkup } from '../ui/markup'
import { loadCommunityPacks } from './packs'
import { ICONS } from '../ui/icons'
import { plainQrElement } from '../../packages/host/src/qr'

export function mountCommunity() {
  const list = document.getElementById('community-packs')!
  const credits = document.getElementById('pack-credits')!
  const search = document.getElementById('pack-search') as HTMLInputElement
  const status = document.getElementById('pack-status')!
  let packs: Pack[] = []
  const render = () => {
    const query = search.value.trim().toLowerCase()
    const matches = packs.filter((p) => `${p.id} ${p.name} ${p.description} ${p.kind} ${p.author.name}`.toLowerCase().includes(query))
    const glyphs = { profile: 'gamepad', mapping: 'settings', mode: 'play', 'scene-link': 'match', 'controller-layout': 'grid', experience: 'glow' }
    setMarkup(list, matches.map((p) => html`<article class="cat-card pack-card" data-pack="${p.id}">
      <div class="pack-art"><span class="pack-kind" aria-label="${p.kind}">${ICONS[glyphs[p.kind]]}</span>
        <span class="st ${p.id.startsWith('obpal/') ? 'example' : 'com'}">${p.id.startsWith('obpal/') ? 'Example' : 'Community'}</span>
        ${p.preview ? html`<img class="pack-preview" src="${p.preview.url}" alt="${p.name} preview" loading="lazy">` : ''}</div>
      <b>${p.name}</b><p class="pack-purpose" title="${p.description}">${p.description}</p><p class="pack-credit">${p.attribution}</p>
      ${p.deprecated ? html`<p>Deprecated: ${p.deprecated.reason}</p>` : p.kind === 'scene-link'
        ? html`<a class="btn pack-primary" href="${p.body.url}" target="_blank" rel="noopener noreferrer">Open scene ${ICONS.open}</a>`
        : p.kind === 'profile' || p.kind === 'mapping' || p.kind === 'mode'
          ? html`<a class="btn pack-primary" href="/p/?pack=${encodeURIComponent(p.id)}">Use on my phone</a>` : html`<p>Specification only</p>`}
      <details class="pack-options"><summary>More options</summary><div class="pack-option-list">
        <details class="pack-data"><summary>Preview pack data</summary><code>${p.id} · ${p.version} · ${p.kind}</code><pre>${JSON.stringify(p.body, null, 2)}</pre></details>
        ${!p.deprecated && (p.kind === 'profile' || p.kind === 'mapping' || p.kind === 'mode') ? html`<details class="pack-handoff"><summary>Send to a phone</summary>
          <p>Scan this pack link with your phone, then connect to a screen.</p>
          ${plainQrElement(new URL(`/p/?pack=${encodeURIComponent(p.id)}`, location.origin).href, `Pack link: ${p.name}`)}</details>` : ''}
        <a href="#credits">Credit and source</a>
        ${p.source ? html`<a href="${p.source}" target="_blank" rel="noopener noreferrer">Source ${ICONS.open}</a>` : ''}
      </div></details>
    </article>`))
    status.textContent = packs.length ? `${matches.length} of ${packs.length} packs` : 'No cached packs. Connect to the internet and reload to get the catalogue.'
  }
  search.addEventListener('input', render)
  void loadCommunityPacks().then((loaded) => {
    packs = loaded
    setMarkup(credits, packs.map((p) => html`<li><b>${p.name}</b> (${p.id} · ${p.version}) — ${p.attribution}
      <span>${packCredit(p)}</span>
      ${p.author.url ? html`<a href="${p.author.url}" target="_blank" rel="noopener noreferrer">Author</a>` : ''}
      <a href="${p.license === 'MIT' ? 'https://spdx.org/licenses/MIT.html' : p.license === 'CC0-1.0' ? 'https://spdx.org/licenses/CC0-1.0.html' : 'https://spdx.org/licenses/CC-BY-4.0.html'}" target="_blank" rel="noopener noreferrer">Licence</a>
      ${p.source ? html`<a href="${p.source}" target="_blank" rel="noopener noreferrer">Source</a>` : ''}</li>`))
    render()
  })
}
